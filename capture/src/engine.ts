import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CaptureSelftest, CaptureStatus } from '../../shared/api.js';
import { Recorder, levels, toneWav } from './audio.js';
import { Chrome, sleep, type PlayerState } from './chrome.js';
import type { CaptureConfig } from './config.js';

/*
 * The engine: one Spotify capture at a time (the account can only stream one song, and there is one speaker), a small
 * queue, and the procedure that turns a track id into a FLAC file:
 *
 *   ensure browser → open the track page → start the recorder → trusted click on play → follow the player's clock
 *   (and refuse it if it is an ad) → stop at the track's own length → the encoder finalises the file.
 *
 * The first byte is written while the song is still playing, so the app can stream it as it arrives.
 */

export type JobState = 'queued' | 'playing' | 'recording' | 'done' | 'failed';

export interface Job {
  id: string;
  trackId: string;
  durationMs: number;
  state: JobState;
  error: string | null;
  file: string;
  bytes: number;
  frames: number;
  createdAt: number;
  cancelled: boolean;
}

/** How long the recorder may run on after Spotify's clock shows the end, to reach the track's exact length. */
export const END_GRACE_MS = 3_000;

export class Engine {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];
  private current: string | null = null;
  private captured = 0;
  private pumping = false;
  private readonly chrome: Chrome;

  constructor(
    private readonly cfg: CaptureConfig,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.chrome = new Chrome(cfg, log);
    // Keep the engine warm (idle stop is opt-in through IDLE_STOP_MINUTES).
    if (cfg.idleStopMinutes > 0) {
      setInterval(() => {
        if (this.current || this.queue.length) return;
        if (Date.now() - this.chrome.usedAt < cfg.idleStopMinutes * 60_000) return;
        void this.chrome.stop().catch(() => undefined);
      }, 60_000).unref();
    }
  }

  /* ------------------------------------------------------------------- public */

  async status(): Promise<Omit<CaptureStatus, 'configured'>> {
    let browser: CaptureStatus['browser'] = 'stopped';
    let loggedIn = false;
    let account: string | null = null;
    try {
      if (this.chrome.running) {
        browser = 'running';
        loggedIn = await this.chrome.loggedIn();
        if (loggedIn) account = await this.chrome.account();
      }
    } catch {
      browser = 'unreachable';
    }
    return {
      browser,
      loggedIn,
      account,
      queued: this.queue.length,
      current: this.current ? (this.jobs.get(this.current)?.trackId ?? null) : null,
      captured: this.captured,
    };
  }

  enqueue(trackId: string, durationMs: number): Job {
    if (!/^[A-Za-z0-9]{22}$/.test(trackId)) throw new Error('not a Spotify track id');
    for (const j of this.jobs.values()) {
      if (j.trackId === trackId && (j.state === 'queued' || j.state === 'playing' || j.state === 'recording')) return j;
    }
    if (this.queue.length >= this.cfg.maxQueue) throw new Error('the Spotify engine is busy; try again shortly');
    const job: Job = {
      id: crypto.randomUUID(),
      trackId,
      durationMs: Math.max(5_000, Math.min(durationMs, 3_600_000)),
      state: 'queued',
      error: null,
      file: path.join(this.cfg.workDir, 'recordings', `${trackId}.flac`),
      bytes: 0,
      frames: 0,
      createdAt: Date.now(),
      cancelled: false,
    };
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.pump();
    return job;
  }

  job(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    if (job.state === 'queued') {
      const i = this.queue.indexOf(id);
      if (i >= 0) this.queue.splice(i, 1);
      job.state = 'failed';
      job.error = 'cancelled';
    }
  }

  async ensure(): Promise<void> {
    await this.chrome.ensure();
  }

  async restart(): Promise<void> {
    if (this.current) throw new Error('the engine is recording; wait for it to finish');
    await this.chrome.restart();
  }

  async stopBrowser(): Promise<void> {
    if (this.current) throw new Error('the engine is recording; wait for it to finish');
    await this.chrome.stop();
  }

  vncPassword(): string {
    return this.chrome.vnc();
  }

  async startLogin(): Promise<void> {
    await this.chrome.startLogin();
  }

  async importCookie(spDc: string): Promise<void> {
    await this.chrome.importCookie(spDc);
  }

  async logout(): Promise<void> {
    await this.chrome.logout();
  }

  /**
   * Proves the capture path without Spotify: plays a generated tone through the engine's own virtual speaker and
   * records it, then checks the length, the trimming, the level and the encoder, plus the Widevine levels Chrome
   * offers. `pageUrl` points at the tone page the HTTP layer serves.
   */
  async selftest(pageUrl: string): Promise<CaptureSelftest> {
    const seconds = 6;
    const expectedFrames = seconds * this.cfg.rate;
    const file = path.join(this.cfg.workDir, 'recordings', 'selftest.flac');
    const wav = path.join(this.cfg.workDir, 'selftest.wav');
    const result: CaptureSelftest = {
      ok: false,
      frames: 0,
      expectedFrames,
      trimmed: false,
      peakDb: -100,
      rmsDb: -100,
      bytes: 0,
      codec: null,
      widevine: [],
    };
    if (this.current) throw new Error('the engine is recording a song; run the test when it is idle');
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // No silence inside the file: the page waits ~0.8 s before it plays, which is exactly the silence the recorder must drop.
    await fsp.writeFile(wav, toneWav({ seconds, rate: this.cfg.rate, channels: this.cfg.channels }));
    await fsp.rm(file, { force: true });
    await this.chrome.ensure();
    result.widevine = await this.chrome.widevine();
    let tab = '';
    const rec = new Recorder({
      file,
      parec: this.cfg.parec,
      ffmpeg: this.cfg.ffmpeg,
      pulseServer: this.cfg.pulseServer,
      sink: this.cfg.sinkName,
      rate: this.cfg.rate,
      channels: this.cfg.channels,
      maxFrames: expectedFrames,
      env: this.chrome.env(),
      silenceTimeoutMs: 15_000,
      log: this.log,
    });
    try {
      // Listen first, then open the page: the tone starts ~1 s after it loads, so the recording begins with silence that
      // the recorder has to drop — the same situation as a real track.
      rec.start();
      await sleep(300);
      tab = await this.chrome.openTab(pageUrl);
      await rec.waitDone();
    } finally {
      await this.chrome.closeTab(tab).catch(() => undefined);
    }
    if (rec.error) return { ...result, error: rec.error };
    const st = await fsp.stat(file).catch(() => null);
    if (!st) return { ...result, error: 'the engine wrote no file' };
    const probe = await this.probe(file);
    const buf = await fsp.readFile(file).catch(() => null);
    // FLAC is compressed: the level check is on the PCM the recorder saw, not on the file.
    const pcm = buf ? { peakDb: rec.levels.peakDb, rmsDb: rec.levels.rmsDb } : levels(Buffer.alloc(0));
    result.frames = rec.frames;
    result.trimmed = rec.trimmedFrames > this.cfg.rate * 0.2;
    result.peakDb = pcm.peakDb;
    result.rmsDb = pcm.rmsDb;
    result.bytes = st.size;
    result.codec = probe.codec;
    // PulseAudio only delivers the monitor stream once the sink is active, so the recording usually starts on the first
    // sample and `trimmed` is 0; the guard stays for the cases where silence does arrive (a stale stream, an ad).
    result.ok =
      Math.abs(rec.frames - expectedFrames) <= expectedFrames * 0.03 &&
      result.rmsDb > -40 &&
      result.rmsDb < -3 &&
      result.codec === 'flac' &&
      result.widevine.length > 0;
    if (!result.ok) result.error = 'the recording did not match the tone (see frames, level, codec and Widevine above)';
    this.log(`selftest: ${result.ok ? 'ok' : 'failed'} (${rec.frames}/${expectedFrames} frames, ${result.peakDb}/${result.rmsDb} dBFS, ${result.codec})`);
    return result;
  }

  /* ------------------------------------------------------------------ internal */

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const job = this.jobs.get(id);
        if (!job || job.cancelled) continue;
        this.current = id;
        try {
          await this.run(job);
          job.state = 'done';
          this.captured++;
        } catch (e) {
          job.state = 'failed';
          job.error = e instanceof Error ? e.message : String(e);
          this.log(`capture ${job.trackId} failed: ${job.error}`);
          // Leave the account quiet: a failed attempt must not keep the song playing (it holds Spotify's one stream).
          await this.chrome.pressPause().catch(() => undefined);
          await fsp.rm(job.file, { force: true }).catch(() => undefined);
        } finally {
          this.current = null;
          // Finished jobs stay readable for a while (the app fetches the file after the stream ends).
          setTimeout(() => this.jobs.delete(id), 10 * 60_000).unref();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const t0 = Date.now();
    await fsp.mkdir(path.dirname(job.file), { recursive: true, mode: 0o700 });
    await fsp.rm(job.file, { force: true });
    await this.chrome.ensure();
    if (!(await this.chrome.loggedIn())) throw new Error('the Spotify engine is not logged in (Settings → Admin → Spotify audio)');
    job.state = 'playing';
    await this.chrome.openTrack(job.trackId);
    if (job.cancelled) throw new Error('cancelled');
    // Preflight: play once and see what the player really starts. Spotify Free inserts an advert before a track now and
    // then; it is waited out here, so an advert is never recorded and the track itself is still captured.
    await this.chrome.pressPlay();
    if (!(await this.confirmTrack(job))) throw new Error('Spotify never started the requested track.');
    if (!(await this.chrome.pauseAndSettle())) throw new Error('Spotify would not pause the track.');
    if (!(await this.chrome.seekToStart())) throw new Error('Spotify would not rewind the track to its start.');

    const rec = new Recorder({
      file: job.file,
      parec: this.cfg.parec,
      ffmpeg: this.cfg.ffmpeg,
      pulseServer: this.cfg.pulseServer,
      sink: this.cfg.sinkName,
      rate: this.cfg.rate,
      channels: this.cfg.channels,
      maxFrames: Math.round((job.durationMs / 1000) * this.cfg.rate),
      env: this.chrome.env(),
      silenceTimeoutMs: 30_000,
      tailHoldMs: 1_500,
      log: this.log,
    });
    rec.on('started', () => {
      job.state = 'recording';
    });
    // Listen first, press play second: the recorder drops the gap and starts the file at the first sample.
    rec.start();
    await sleep(350);
    await this.chrome.pressPlay();

    const started = Date.now();
    let verified = false;
    let lastPosition = -1;
    let stalls = 0;
    let state: PlayerState | null = null;
    let endSeen: number | null = null;
    while (true) {
      await sleep(250);
      if (job.cancelled) {
        await rec.stop().catch(() => undefined);
        throw new Error('cancelled');
      }
      if (rec.state === 'failed') throw new Error(rec.error ?? 'the recording failed');
      if (rec.state === 'done') break;
      if (Date.now() - started > job.durationMs + 120_000) {
        await rec.stop().catch(() => undefined);
        throw new Error('the capture did not finish in time');
      }
      state = await this.chrome.player();
      if (!state) continue;
      if (!verified && state.position > 0.4) {
        // Safety net: the clock must be near the start (it moves with real time from 0). A track that resumed mid-song
        // would otherwise become a file of its second half.
        if (state.position > (Date.now() - started) / 1000 + 3) {
          await rec.stop().catch(() => undefined);
          throw new Error(`Spotify resumed the track at ${Math.round(state.position)} s instead of its start — try again.`);
        }
        // Spotify tells us what it is actually playing: an advert (or a queue that moved on) must not become the file.
        if (state.duration > 0 && Math.abs(state.duration * 1000 - job.durationMs) > 5_000) {
          await rec.stop().catch(() => undefined);
          throw new Error(
            `Spotify played a different recording (${Math.round(state.duration)} s instead of ${Math.round(job.durationMs / 1000)} s) — try again.`,
          );
        }
        verified = true;
      }
      // The clock shows whole seconds, so "3:38 / 3:38" appears up to a second before the audio really ends: the end is
      // the recorder reaching the track's exact length (maxFrames → state 'done'). The clock only starts a short grace
      // period, cut short when Spotify visibly moves on to another song (its length or a restarted clock).
      const atEnd = state.ended || (verified && state.position >= Math.max(0, state.duration - 0.5));
      if (atEnd && endSeen === null) endSeen = Date.now();
      if (endSeen !== null) {
        const movedOn = state.duration > 0 && (Math.abs(state.duration * 1000 - job.durationMs) > 5_000 || (!atEnd && state.position < 5));
        if (movedOn || Date.now() - endSeen > END_GRACE_MS) break;
        continue;
      }
      if (Math.abs(state.position - lastPosition) < 0.02) stalls++;
      else stalls = 0;
      lastPosition = state.position;
      if (stalls > 40) {
        await rec.stop().catch(() => undefined);
        throw new Error('Spotify stopped playing before the track ended');
      }
    }
    await rec.stop();
    job.frames = rec.frames;
    if (rec.state !== 'done') throw new Error(rec.error ?? 'the recording did not finish');
    const st = await fsp.stat(job.file).catch(() => null);
    if (!st || st.size < 10_000) throw new Error('the recording is empty (did the page play any audio?)');
    job.bytes = st.size;
    await this.chrome.pressPause().catch(() => undefined);
    this.log(`captured ${job.trackId} (${rec.frames} frames, ${Math.round(st.size / 1024)} KiB, ${Math.round((Date.now() - t0) / 1000)} s)`);
  }

  /**
   * Waits until the player is playing the track we asked for: the track page's own button reads "Pause" (the player is on
   * this page's track, not a playlist or whatever the bar had queued from an earlier session) and the player's duration
   * is the track's. Anything else — an advert, a queue that moved on — is waited out; Spotify plays the requested track
   * after it by itself. A player that sits idle is nudged with the page's play button. False = it never came.
   */
  private async confirmTrack(job: Job): Promise<boolean> {
    const deadline = Date.now() + 180_000;
    let announced: number | null = null;
    let idle = 0;
    while (Date.now() < deadline) {
      await sleep(500);
      const p = await this.chrome.player();
      const mine = await this.chrome.trackPagePlaying();
      if (!p || p.duration <= 0) continue;
      const ms = Math.round(p.duration * 1000);
      const rightLength = Math.abs(ms - job.durationMs) <= 5_000;
      if (mine && rightLength) return true;
      // Nothing of ours is playing (a stale bar from an earlier attempt, another song left paused, a lost click): press
      // the page's own button again every 5 s. A playing advert is left alone.
      if (!mine && p.paused) {
        if (++idle % 10 === 0) await this.chrome.pressPlay();
        continue;
      }
      if (rightLength) continue;
      if (announced !== ms) {
        announced = ms;
        this.log(`capture ${job.trackId}: waiting out ${Math.round(ms / 1000)} s of something else (an advert)`);
      }
    }
    return false;
  }

  private probe(file: string): Promise<{ codec: string | null }> {
    return new Promise((resolve) => {
      const p = spawn(this.cfg.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'json', file], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      p.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      p.on('close', () => {
        try {
          const j = JSON.parse(out) as { streams?: { codec_name?: string }[] };
          resolve({ codec: j.streams?.[0]?.codec_name ?? null });
        } catch {
          resolve({ codec: null });
        }
      });
      p.on('error', () => resolve({ codec: null }));
    });
  }
}
