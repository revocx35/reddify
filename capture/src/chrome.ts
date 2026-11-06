import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Cdp } from './cdp.js';
import type { CaptureConfig } from './config.js';

/*
 * The engine's browser: Xvfb + PulseAudio + Google Chrome, one of each, started on demand.
 *
 * Chrome (not Chromium) because only Chrome ships Google's Widevine CDM, which Spotify's web player needs to decrypt
 * its own stream. Chrome plays; this file never touches the CDM, the keys or the decrypted buffers — it only drives the
 * page (navigate, click play, read the player's clock) and the audio leaves through the PulseAudio sink.
 */

const ORIGIN = 'https://open.spotify.com';
const LOGIN_URL = 'https://accounts.spotify.com/login?continue=' + encodeURIComponent(ORIGIN + '/');

export interface PlayerState {
  /** Playback position and the player's own duration, in seconds. */
  position: number;
  duration: number;
  ended: boolean;
  paused: boolean;
  volume: number;
  muted: boolean;
  /** What the page's Media Session says is playing (artist/title), for the ad and wrong-track checks. */
  title: string | null;
  artist: string | null;
}

/**
 * Spotify's advert and ad-telemetry hosts, sent to a dead local address while the engine's Chrome runs when BLOCK_ADS is
 * on. Deliberately only these: the music itself arrives from the audio CDNs (`*.spotify.com`, `*.akamaized.net`) and the
 * player's API (`spclient.wg.spotify.com`) must never be touched, or playback breaks instead of the advert going away.
 *
 * This is the robust version of "install an ad blocker": a current Chrome refuses extensions loaded from the command line
 * (`--load-extension` was removed in Chrome 137) and no longer runs uBlock Origin's manifest-v2 build at all, while a
 * network-level rule needs no extension, no policy and no Web Store round trip inside a read-only container.
 */
export function adResolverRules(): string {
  const hosts = [
    'ads-fa.spotify.com',
    'adeventtracker.spotify.com',
    'pubads.g.doubleclick.net',
    'securepubads.g.doubleclick.net',
    'googleads.g.doubleclick.net',
    'pagead2.googlesyndication.com',
  ];
  return hosts.map((h) => `MAP ${h} 127.0.0.1`).join(', ');
}

export class Chrome {
  private xvfb: ChildProcess | null = null;
  private pulse: ChildProcess | null = null;
  private browser: ChildProcess | null = null;
  private cdp: Cdp | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private vncProc: ChildProcess | null = null;
  private shuttingDown = false;
  private loginTarget: string | null = null;
  private loginPoll: NodeJS.Timeout | null = null;
  private starting: Promise<void> | null = null;
  private vncPassword = '';
  private lastUsed = Date.now();

  constructor(
    private readonly cfg: CaptureConfig,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  get running(): boolean {
    return !!this.browser && !!this.cdp?.isOpen && !!this.sessionId;
  }

  get usedAt(): number {
    return this.lastUsed;
  }

  vnc(): string {
    return this.vncPassword;
  }

  /* ------------------------------------------------------------------ lifecycle */

  async ensure(): Promise<void> {
    this.lastUsed = Date.now();
    if (this.running) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  private async start(): Promise<void> {
    this.shuttingDown = false;
    fs.mkdirSync(this.cfg.workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.cfg.workDir, 'home'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.cfg.workDir, 'tmp'), { recursive: true, mode: 0o700 });
    // A PulseAudio cookie shared by the daemon and its clients (Chrome, parec): without a writable one the clients try
    // to create it next to their working directory, which is read-only in this image.
    const pulseDir = path.join(this.cfg.workDir, 'home', '.config', 'pulse');
    fs.mkdirSync(pulseDir, { recursive: true, mode: 0o700 });
    const cookiePath = path.join(pulseDir, 'cookie');
    if (!fs.existsSync(cookiePath)) fs.writeFileSync(cookiePath, crypto.randomBytes(256), { mode: 0o600 });
    fs.mkdirSync(path.dirname(this.cfg.chromeProfile), { recursive: true, mode: 0o700 });
    this.vncPassword = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    await fsp.writeFile(path.join(this.cfg.workDir, 'vncpw'), this.vncPassword, { mode: 0o600 });

    this.startXvfb();
    await this.waitFor(() => this.xvfbAlive(), 10_000, 'Xvfb did not start');
    // The live screen the admin logs the engine in on (noVNC in Settings → Admin); the tunnel in server.ts connects to
    // this port, so without it the panel says "connection lost".
    this.startVnc();
    this.startPulse();
    await this.waitFor(async () => this.pulseReady(), 15_000, 'PulseAudio did not start');
    this.startChrome();
    await this.waitFor(async () => this.browserReady(), 40_000, 'Chrome did not expose DevTools');

    const cdp = await Cdp.connect(await this.wsUrl());
    cdp.on('close', () => {
      this.cdp = null;
      this.sessionId = null;
    });
    cdp.on('event', (method: string, params: Record<string, unknown>) => {
      if (method === 'Target.targetDestroyed') {
        if (params.targetId === this.targetId) {
          this.sessionId = null;
          this.targetId = null;
        }
        if (params.targetId === this.loginTarget) this.loginTarget = null;
      }
    });
    this.cdp = cdp;
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    await this.attachPlayerPage();
    this.log('browser ready');
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    this.cdp?.close();
    this.cdp = null;
    this.sessionId = null;
    this.targetId = null;
    for (const p of [this.browser, this.pulse, this.vncProc, this.xvfb]) {
      if (p && p.exitCode === null) p.kill('SIGTERM');
    }
    // Chrome flushes its profile before it goes; give it a moment, then be firm.
    await new Promise((r) => setTimeout(r, 1500));
    for (const p of [this.browser, this.pulse, this.vncProc, this.xvfb]) {
      if (p && p.exitCode === null) p.kill('SIGKILL');
    }
    this.browser = null;
    this.pulse = null;
    this.vncProc = null;
    this.xvfb = null;
    this.log('browser stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.ensure();
  }

  /* --------------------------------------------------------------- supervision */

  private childEnv(): NodeJS.ProcessEnv {
    return {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: path.join(this.cfg.workDir, 'home'),
      TMPDIR: path.join(this.cfg.workDir, 'tmp'),
      DISPLAY: `:${this.cfg.display}`,
      PULSE_SERVER: this.cfg.pulseServer,
      PULSE_SINK: this.cfg.sinkName,
      PULSE_COOKIE: path.join(this.cfg.workDir, 'home', '.config', 'pulse', 'cookie'),
      TZ: this.cfg.timeZone,
      LANG: 'en_US.UTF-8',
      DBUS_SESSION_BUS_ADDRESS: 'disabled:',
    };
  }

  /** The environment every child of the engine shares (Chrome, the daemon, parec/ffmpeg). */
  env(): NodeJS.ProcessEnv {
    return this.childEnv();
  }

  private startXvfb(): void {
    // -ac: no X access control inside this container (only these processes share the display).
    this.xvfb = spawn(
      'Xvfb',
      [`:${this.cfg.display}`, '-screen', '0', `${this.cfg.width}x${this.cfg.height}x24`, '-nolisten', 'tcp', '-ac', '-dpi', '96'],
      { stdio: ['ignore', 'ignore', 'pipe'], env: this.childEnv() },
    );
    this.xvfb.stderr?.on('data', (d: Buffer) => this.log(`Xvfb: ${d.toString().trim()}`));
    this.xvfb.on('exit', (code) => this.log(`Xvfb exited (${code})`));
  }

  private xvfbAlive(): boolean {
    return !!this.xvfb && this.xvfb.exitCode === null && fs.existsSync(`/tmp/.X11-unix/X${this.cfg.display}`);
  }

  /** x11vnc on the engine's virtual screen, with the per-start password the admin panel fetches. */
  private startVnc(): void {
    const pwFile = path.join(this.cfg.workDir, 'vncpw');
    const spawnVnc = (): void => {
      const p = spawn(
        'x11vnc',
        [
          '-display',
          `:${this.cfg.display}`,
          '-rfbport',
          '5900',
          '-localhost',
          '-noipv6',
          '-passwdfile',
          `read:${pwFile}`,
          '-forever',
          '-shared',
          '-noxdamage',
          '-nowf',
          '-quiet',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], env: this.childEnv() },
      );
      this.vncProc = p;
      let err = '';
      p.stderr?.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-2000);
      });
      p.on('exit', (code) => {
        this.vncProc = null;
        if (this.shuttingDown) return;
        this.log(`x11vnc exited (${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}; restarting`);
        setTimeout(() => {
          if (!this.shuttingDown) spawnVnc();
        }, 2000).unref();
      });
    };
    spawnVnc();
  }

  private startPulse(): void {
    // The virtual speaker. Chrome's audio goes to this null sink and never to a real device; module-native-protocol-unix
    // is the socket the recorder (parec) reads from.
    this.pulse = spawn(
      'pulseaudio',
      [
        '--daemonize=no',
        '--exit-idle-time=-1',
        '--disallow-exit',
        '-n',
        '--log-target=stderr',
        '--log-level=warning',
        '-L',
        `module-null-sink sink_name=${this.cfg.sinkName} rate=${this.cfg.rate} channels=${this.cfg.channels} format=s16le sink_properties=device.description=ReddifySpeaker`,
        '-L',
        `module-native-protocol-unix socket=${this.cfg.pulseServer.replace(/^unix:/, '')} auth-anonymous=1`,
        '-L',
        'module-always-sink',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: this.childEnv() },
    );
    this.pulse.stderr?.on('data', (d: Buffer) => this.log(`pulseaudio: ${d.toString().trim()}`));
    this.pulse.on('exit', (code) => this.log(`pulseaudio exited (${code})`));
  }

  private async pulseReady(): Promise<boolean> {
    const socket = this.cfg.pulseServer.replace(/^unix:/, '');
    if (!this.pulse || this.pulse.exitCode !== null || !fs.existsSync(socket)) return false;
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn('pactl', [`--server=${this.cfg.pulseServer}`, 'info'], { stdio: 'ignore', env: this.childEnv() });
      p.on('close', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
    });
    return ok;
  }

  private startChrome(): void {
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      fs.rmSync(path.join(this.cfg.chromeProfile, f), { force: true });
    }
    const args = [
      `--user-data-dir=${this.cfg.chromeProfile}`,
      '--remote-debugging-port=9222',
      '--kiosk',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--disable-features=Translate,MediaRouter,DialMediaRouteProvider,OptimizationHints',
      '--disable-component-update',
      '--noerrdialogs',
      '--hide-crash-restore-bubble',
      '--disable-session-crashed-bubble',
      '--lang=en-US',
      '--force-device-scale-factor=1',
      // Software WebGL, as in the catalogue browser: a browser without it looks like a bot to Spotify's login.
      '--ignore-gpu-blocklist',
      // The engine must keep playing while it is not the visible window, and its timers must not be throttled.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      // Playback is started by a trusted click; this removes the last autoplay hurdle (the selftest needs it too).
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=0,0`,
      `--window-size=${this.cfg.width},${this.cfg.height}`,
    ];
    if (this.cfg.blockAds) args.push(`--host-resolver-rules=${adResolverRules()}`);
    args.push(ORIGIN + '/');
    this.browser = spawn(this.cfg.chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: this.childEnv() });
    let err = '';
    this.browser.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
      if (/ERROR|FATAL/.test(d.toString())) this.log(`chrome: ${d.toString().trim().slice(0, 300)}`);
    });
    this.browser.on('exit', (code) => {
      const tail = err.trim().split('\n').pop() ?? '';
      this.log(`chrome exited (${code})${tail ? `: ${tail}` : ''}`);
      this.cdp?.close();
      this.cdp = null;
      this.sessionId = null;
    });
  }

  private async browserReady(): Promise<boolean> {
    if (!this.browser || this.browser.exitCode !== null) return false;
    try {
      const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  private async wsUrl(): Promise<string> {
    const r = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(3000) });
    const info = (await r.json()) as { webSocketDebuggerUrl?: string };
    if (!info.webSocketDebuggerUrl) throw new Error('Chrome did not offer a DevTools endpoint');
    return info.webSocketDebuggerUrl;
  }

  /* ----------------------------------------------------------------------- page */

  private async attachPlayerPage(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) throw new Error('the browser is not connected');
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    let target = pages.find((t) => t.url.startsWith(ORIGIN)) ?? pages.find((t) => t.url === 'about:blank') ?? pages[0];
    let navigate = !target || !target.url.startsWith(ORIGIN);
    if (!target) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      target = { targetId, type: 'page', url: 'about:blank' };
      navigate = true;
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = target.targetId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    if (navigate) await this.goto(ORIGIN + '/');
    await this.waitFor(async () => (await this.readyState()) === 'complete', 30_000, 'Spotify did not load');
    await sleep(1500);
  }

  private async readyState(): Promise<string> {
    const v = await this.evaluate<string>('document.readyState');
    return typeof v === 'string' ? v : '';
  }

  async goto(url: string): Promise<void> {
    if (!this.cdp || !this.sessionId) throw new Error('the browser is not connected');
    await this.cdp.send('Page.navigate', { url }, this.sessionId, 45_000);
  }

  /** Navigates to a track page and waits until its player is on screen. */
  async openTrack(trackId: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.goto(`${ORIGIN}/track/${trackId}`);
      // waitFor resolves with nothing, so success is mapped to `true` here (comparing its result was always falsy and
      // failed every capture). A check that throws mid-navigation (context destroyed) counts as "not yet".
      const ok = await this.waitFor(
        async () =>
          // The track page's own button, not any play button: the now-playing bar (and the sidebar's) render first, and
          // pressPlay needs this one.
          (await this.evaluate<boolean>(`!!(${Chrome.TRACK_PLAY})`).catch(
            () => false,
          )) === true,
        25_000,
        'the track page did not render',
      ).then(
        () => true,
        () => false,
      );
      if (ok || attempt === 1) {
        if (!ok) throw new Error('Spotify did not render the track page.');
        break;
      }
    }
    await this.ensureVolume();
  }

  /**
   * The player's own volume, not the sink's: a page left at 30 % would be recorded at 30 %. Spotify's web player builds
   * its media element with `new Audio()` (it is not in the DOM), so when there is no element to set, its volume slider
   * is driven to the top instead.
   */
  async ensureVolume(): Promise<void> {
    const where = await this.evaluate<{ x: number; y: number } | 'element' | 'none'>(`(() => {
      const v = document.querySelector('video, audio');
      if (v) {
        v.volume = 1;
        v.muted = false;
        return 'element';
      }
      const mute = document.querySelector('[data-testid="volume-bar-toggle-mute-button"]');
      if (mute && mute.getAttribute('aria-label') === 'Unmute') mute.click();
      const bar = document.querySelector('[data-testid="volume-bar"]');
      if (!bar) return 'none';
      const r = bar.getBoundingClientRect();
      if (r.width <= 0) return 'none';
      return { x: Math.round(r.right - 3), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!where || where === 'none' || where === 'element') return;
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp!.send('Input.dispatchMouseEvent', { type, x: where.x, y: where.y, button: 'left', clickCount: 1 }, this.sessionId!);
    }
  }

  /**
   * Rewinds the player to the very start of the track (a trusted click on the left edge of Spotify's progress bar), so a
   * recording that has to be restarted — after an advert, say — begins at the first sample instead of mid-song.
   */
  async seekToStart(): Promise<boolean> {
    // Spotify sometimes ignores a seek right after a pause/play change, and its clock text lags: try a few times, each
    // with a trusted click on the bar's left edge and then the Home key on the bar's range input, and give the clock
    // up to 2 s to show the rewind.
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = await this.evaluate<{ x: number; y: number } | null>(`(() => {
        const bar = document.querySelector('[data-testid="playback-progressbar"]');
        if (!bar) return null;
        const r = bar.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + 1), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (!at) return false;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await this.cdp!.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 }, this.sessionId!);
      }
      if (await this.rewound(1000)) return true;
      const focused = await this.evaluate<boolean>(
        `(() => { const i = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]'); if (!i) return false; i.focus(); return true; })()`,
      );
      if (focused) {
        for (const type of ['keyDown', 'keyUp'] as const) {
          await this.cdp!.send('Input.dispatchKeyEvent', { type, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 }, this.sessionId!);
        }
        if (await this.rewound(1000)) return true;
      }
      await sleep(500);
    }
    return false;
  }

  /**
   * True once the player's clock shows the start of the track (within `ms`) and still does a second later: Spotify's
   * bar shows a seek at once and can snap back when the player's own state disagrees.
   */
  private async rewound(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    do {
      await sleep(250);
      const p = await this.player().catch(() => null);
      if (p && p.position <= 1) {
        await sleep(1000);
        const again = await this.player().catch(() => null);
        if (again && again.position <= 1) return true;
      }
    } while (Date.now() < deadline);
    return false;
  }

  /**
   * The track page's own play button. Never the first `play-button` in the document: the library sidebar has one per
   * playlist ("Play Liked Songs" comes first), and pressing it plays that playlist instead of the track. Never the
   * now-playing bar either: that resumes whatever Spotify had queued last.
   */
  static readonly TRACK_PLAY = `document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"]') || document.querySelector('[data-testid="track-page"] [data-testid="play-button"]')`;

  /** True while the open track page's own button reads "Pause", i.e. the player is playing this page's track. */
  async trackPagePlaying(): Promise<boolean> {
    const label = await this.evaluate<string | null>(`(() => { const b = ${Chrome.TRACK_PLAY}; return b ? b.getAttribute('aria-label') : null; })()`).catch(
      () => null,
    );
    return label === 'Pause';
  }

  /** A trusted click (Chromium's Input domain counts as a real user gesture) on the track page's own play button. */
  async pressPlay(): Promise<void> {
    const target = await this.evaluate<{ x: number; y: number } | 'playing' | null>(`(() => {
      const el = ${Chrome.TRACK_PLAY};
      if (!el) return null;
      if (el.getAttribute('aria-label') === 'Pause') return 'playing';
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (target === 'playing') return;
    if (!target) throw new Error('the track page has no play button');
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.cdp!.send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(target.x),
        y: Math.round(target.y),
        button: 'left',
        clickCount: 1,
      }, this.sessionId!);
    }
  }

  async pressPause(): Promise<void> {
    await this.evaluate(`(() => { const b = document.querySelector('[data-testid="control-button-playpause"]'); if (b && b.getAttribute('aria-label') === 'Pause') b.click(); return true; })()`);
  }

  /**
   * Pauses and waits until the pause has really landed: the bar's button reads "Play" and the clock has stopped. A seek
   * sent while the pause is still in flight is undone by it (the clock showed 0:00, then jumped back to 2:25 and the
   * recording started there).
   */
  async pauseAndSettle(timeoutMs = 5_000): Promise<boolean> {
    await this.pressPause();
    const deadline = Date.now() + timeoutMs;
    let last: number | null = null;
    while (Date.now() < deadline) {
      await sleep(400);
      const p = await this.player().catch(() => null);
      if (!p) continue;
      if (p.paused && last !== null && p.position === last) return true;
      last = p.paused ? p.position : null;
      if (!p.paused) await this.pressPause();
    }
    return false;
  }

  private async key(key: string, text: string, code: number): Promise<void> {
    const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text, unmodifiedText: text };
    await this.cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, this.sessionId!);
    await this.cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }, this.sessionId!);
  }

  /**
   * What the player is doing. Spotify builds its media element with `new Audio()`, so it is usually not in the DOM and
   * the player's own clock (`playback-position` / `playback-duration`, in the now-playing bar) is what can be read.
   */
  async player(): Promise<PlayerState | null> {
    return this.evaluate<PlayerState | null>(`(() => {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      const title = md ? md.title : null;
      const artist = md ? md.artist : null;
      const v = document.querySelector('video, audio');
      if (v) {
        return {
          position: v.currentTime || 0,
          duration: Number.isFinite(v.duration) ? v.duration : 0,
          ended: !!v.ended,
          paused: !!v.paused,
          volume: v.volume,
          muted: !!v.muted,
          title,
          artist,
        };
      }
      const clock = (sel) => {
        const el = document.querySelector(sel);
        if (!el || !el.textContent) return null;
        const parts = el.textContent.trim().split(':');
        if (parts.length !== 2) return null;
        const mm = Number(parts[0]);
        const ss = Number(parts[1]);
        if (!Number.isInteger(mm) || !Number.isInteger(ss)) return null;
        return mm * 60 + ss;
      };
      const position = clock('[data-testid="playback-position"]');
      const duration = clock('[data-testid="playback-duration"]');
      if (position === null && duration === null) return null;
      // Spotify leaves navigator.mediaSession.playbackState at 'none' while playing: the bar's own button is the truth
      // ("Pause" while playing).
      const pp = document.querySelector('[data-testid="control-button-playpause"]');
      const state = navigator.mediaSession ? navigator.mediaSession.playbackState : 'none';
      return {
        position: position === null ? 0 : position,
        duration: duration === null ? 0 : duration,
        ended: false,
        paused: pp ? pp.getAttribute('aria-label') !== 'Pause' : state !== 'playing',
        volume: 1,
        muted: false,
        title,
        artist,
      };
    })()`);
  }

  /** What the page's Media Session calls the current song (used for the ad check). */
  async nowPlaying(): Promise<{ title: string | null; artist: string | null }> {
    const p = await this.player();
    return { title: p?.title ?? null, artist: p?.artist ?? null };
  }

  /** Opens a page in a new tab (the selftest tone page) and returns its target id. */
  async openTab(url: string): Promise<string> {
    if (!this.cdp?.isOpen) throw new Error('the browser is not connected');
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url });
    return targetId;
  }

  async closeTab(targetId: string): Promise<void> {
    await this.cdp?.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }

  /* --------------------------------------------------------------------- login */

  async loggedIn(): Promise<boolean> {
    if (!this.cdp?.isOpen) return false;
    try {
      const { cookies } = await this.cdp.send<{ cookies: { name: string }[] }>('Storage.getCookies', {});
      return cookies.some((c) => c.name === 'sp_dc');
    } catch {
      return false;
    }
  }

  async account(): Promise<string | null> {
    if (!(await this.loggedIn())) return null;
    const name = await this.evaluate<string | null>(`(() => {
      const el = document.querySelector('[data-testid="user-widget-link"], [data-testid="user-widget-dropdown-trigger"]');
      const label = el && (el.getAttribute('aria-label') || el.textContent);
      return label ? String(label).trim().slice(0, 80) : null;
    })()`).catch(() => null);
    return typeof name === 'string' && name ? name : null;
  }

  async startLogin(): Promise<void> {
    await this.ensure();
    const cdp = this.cdp!;
    if (this.loginTarget) await cdp.send('Target.closeTarget', { targetId: this.loginTarget }).catch(() => undefined);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: LOGIN_URL });
    this.loginTarget = targetId;
    if (this.loginPoll) clearInterval(this.loginPoll);
    const started = Date.now();
    this.loginPoll = setInterval(() => {
      void (async () => {
        if (!this.loginTarget || Date.now() - started > 30 * 60_000) return this.finishLogin();
        if (await this.loggedIn()) await this.finishLogin(true);
      })();
    }, 3000);
    this.loginPoll.unref();
  }

  private async finishLogin(ok = false): Promise<void> {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    const t = this.loginTarget;
    this.loginTarget = null;
    if (t) await this.cdp?.send('Target.closeTarget', { targetId: t }).catch(() => undefined);
    if (ok) {
      this.log('Spotify login detected');
      if (this.sessionId) await this.cdp?.send('Page.reload', {}, this.sessionId).catch(() => undefined);
    }
  }

  async importCookie(spDc: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,600}$/.test(spDc)) throw new Error('That does not look like an sp_dc cookie value.');
    await this.ensure();
    await this.cdp!.send('Storage.setCookies', {
      cookies: [
        {
          name: 'sp_dc',
          value: spDc,
          domain: '.spotify.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
          expires: Math.floor(Date.now() / 1000) + 365 * 86_400,
        },
      ],
    });
    if (this.sessionId) await this.cdp!.send('Page.reload', {}, this.sessionId);
    await sleep(2500);
  }

  async logout(): Promise<void> {
    await this.ensure();
    await this.cdp!.send('Storage.clearCookies', {});
    if (this.sessionId) await this.cdp!.send('Page.navigate', { url: ORIGIN + '/' }, this.sessionId);
    await sleep(2000);
  }

  /* ------------------------------------------------------------------ widevine */

  /** The Widevine robustness levels this Chrome offers; L3 playback needs SW_SECURE_CRYPTO. */
  async widevine(): Promise<string[]> {
    const r = await this.evaluate<string[]>(`(async () => {
      const out = [];
      for (const robustness of ['SW_SECURE_CRYPTO', 'SW_SECURE_DECODE', 'HW_SECURE_CRYPTO']) {
        try {
          await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
            initDataTypes: ['cenc'],
            audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness }],
          }]);
          out.push(robustness);
        } catch (e) { /* not available */ }
      }
      return out;
    })()`).catch(() => []);
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
  }

  /* --------------------------------------------------------------------- utils */

  async evaluate<T>(expression: string): Promise<T | null> {
    if (!this.cdp || !this.sessionId) return null;
    const r = await this.cdp.send<{ result?: { value?: T }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      20_000,
    );
    return r.result?.value ?? null;
  }

  private async waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(150);
    }
    throw new Error(message);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
