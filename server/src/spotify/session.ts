import crypto from 'node:crypto';
import type { Repo } from '../db/repo.js';
import { AppError, Errors } from '../errors.js';
import { Cdp } from './cdp.js';
import { ChromiumLink } from './chromium.js';
import { isPersistedQueryNotFound } from './parse.js';

/*
 * One Spotify web player session = one Chromium instance (chromium container) with a tab on open.spotify.com.
 *
 * Reddify never signs or mints Spotify tokens. It watches the web player's own GraphQL requests (CDP Network events)
 * to learn (a) the current request headers (bearer + client-token, refreshed by the player itself) and (b) each
 * operation's persisted-query hash and variable template, then replays an operation *inside the page* with fetch(),
 * so the request comes from Spotify's own origin, cookies and TLS stack. An unknown or stale operation is learned by
 * opening the page of the web player that uses it (LEARN_URLS). Headers and hashes are never logged.
 */

const ORIGIN = 'https://open.spotify.com';
const PATHFINDER = 'https://api-partner.spotify.com/pathfinder/';
const HEADER_KEYS = ['authorization', 'client-token', 'app-platform', 'spotify-app-version'] as const;
/** Spotify access tokens live one hour; reload the tab before ours gets that old. */
const HEADER_MAX_AGE_MS = 50 * 60_000;

/** A page of the web player that issues each operation (sample ids are public catalogue items). */
export const LEARN_URLS: Record<string, string> = {
  home: '/',
  searchDesktop: '/search/daft%20punk',
  searchTracks: '/search/daft%20punk/tracks',
  getAlbum: '/album/2noRn2Aes5aoNVsU6iWThc',
  queryArtistOverview: '/artist/4tZwfgrHOc3mvqYlEYSvVi',
  fetchPlaylist: '/playlist/37i9dQZEVXbNG2KDcFcKOF',
  getTrack: '/track/0DiWol3AO6WpXZgp0goxAV',
  internalLinkRecommenderTrack: '/track/0DiWol3AO6WpXZgp0goxAV',
  libraryV3: '/collection/playlists',
  fetchLibraryTracks: '/collection/tracks',
  profileAttributes: '/',
};

export interface QueryResult {
  data: unknown;
}

type Headers = Partial<Record<(typeof HEADER_KEYS)[number], string>>;

export function instanceToken(secret: Buffer, id: number): string {
  return crypto.createHmac('sha256', secret).update(`rdf/chromium/instance/${id}`).digest('hex');
}

export class SpotifySession {
  readonly link: ChromiumLink;
  private cdp: Cdp | null = null;
  private sessionId: string | null = null;
  private targetId: string | null = null;
  private loginTarget: string | null = null;
  private headers: Headers = {};
  private headersAt = 0;
  private connecting: Promise<void> | null = null;
  private learning: Promise<void> = Promise.resolve();
  private readonly headerWaiters = new Set<() => void>();
  private readonly opWaiters = new Map<string, Set<() => void>>();
  private loginPoll: NodeJS.Timeout | null = null;
  lastUsed = Date.now();

  constructor(
    readonly instance: number,
    private readonly repo: Repo,
    chromiumUrl: string,
    controlSecret: Buffer,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.link = new ChromiumLink(chromiumUrl, instance, instanceToken(controlSecret, instance));
  }

  get connected(): boolean {
    return !!this.cdp?.isOpen && !!this.sessionId;
  }

  get loginInProgress(): boolean {
    return this.loginTarget !== null;
  }

  learnedOps(): string[] {
    return this.repo.ops().map((o) => o.name);
  }

  /* ------------------------------------------------------------------ connection */

  /** Starts the browser if needed, attaches to (or opens) the web player tab and waits for its first request. */
  async ready(): Promise<void> {
    this.lastUsed = Date.now();
    if (this.connected && this.headers.authorization) {
      if (Date.now() - this.headersAt > HEADER_MAX_AGE_MS) await this.reloadForHeaders();
      return;
    }
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  private async connect(): Promise<void> {
    if (!this.cdp?.isOpen) {
      if (!(await this.link.ensure())) throw Errors.unavailable('The Spotify browser is not reachable.');
      const opts = await this.link.connectOptions();
      const cdp = await Cdp.connect(opts.browserWSEndpoint, opts.headers);
      cdp.on('event', (method: string, params: Record<string, unknown>, sid?: string) => this.onEvent(method, params, sid));
      cdp.on('close', () => {
        if (this.cdp === cdp) {
          this.cdp = null;
          this.sessionId = null;
          this.targetId = null;
          this.loginTarget = null;
        }
      });
      this.cdp = cdp;
      await cdp.send('Target.setDiscoverTargets', { discover: true });
    }
    const cdp = this.cdp;
    const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    let target = pages.find((t) => t.url.startsWith(ORIGIN));
    let navigate = false;
    if (!target) {
      target = pages.find((t) => t.url === 'about:blank') ?? pages[0];
      navigate = true;
    }
    if (!target) {
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
      target = { targetId, type: 'page', url: 'about:blank' };
    }
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.sessionId = sessionId;
    this.targetId = target.targetId;
    await cdp.send('Network.enable', { maxPostDataSize: 65_536 }, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    this.headers = {};
    if (navigate) await this.navigate('/');
    else await cdp.send('Page.reload', { ignoreCache: false }, sessionId);
    await this.waitHeaders(30_000);
  }

  private async reloadForHeaders(): Promise<void> {
    if (!this.cdp || !this.sessionId) return;
    this.headers = {};
    await this.cdp.send('Page.reload', {}, this.sessionId);
    await this.waitHeaders(30_000);
  }

  private navigate(pathname: string): Promise<unknown> {
    if (!this.cdp || !this.sessionId) throw Errors.unavailable('The Spotify browser is not connected.');
    return this.cdp.send('Page.navigate', { url: ORIGIN + pathname }, this.sessionId);
  }

  private waitHeaders(timeoutMs: number): Promise<void> {
    if (this.headers.authorization) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.headerWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.headerWaiters.delete(done);
        reject(Errors.unavailable('Spotify did not load in the browser.'));
      }, timeoutMs);
      this.headerWaiters.add(done);
    });
  }

  private waitOp(name: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let set = this.opWaiters.get(name);
      if (!set) this.opWaiters.set(name, (set = new Set()));
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve(true);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        resolve(false);
      }, timeoutMs);
      set.add(done);
    });
  }

  /* ---------------------------------------------------------------------- events */

  private onEvent(method: string, params: Record<string, unknown>, sid?: string): void {
    if (method === 'Target.targetDestroyed' && params.targetId === this.loginTarget) {
      this.loginTarget = null;
      return;
    }
    if (method === 'Target.targetDestroyed' && params.targetId === this.targetId) {
      this.sessionId = null;
      this.targetId = null;
      return;
    }
    if (method !== 'Network.requestWillBeSent' || sid !== this.sessionId) return;
    const req = params.request as { url?: string; method?: string; headers?: Record<string, string>; postData?: string } | undefined;
    if (!req?.url?.startsWith(PATHFINDER)) return;
    this.capture(req);
  }

  /** Exposed for tests: records headers and the operation of one web player request. */
  capture(req: { url?: string; method?: string; headers?: Record<string, string>; postData?: string }): void {
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) lower[k.toLowerCase()] = String(v);
    if (lower.authorization?.startsWith('Bearer ')) {
      const h: Headers = {};
      for (const k of HEADER_KEYS) if (lower[k] && lower[k].length < 4096) h[k] = lower[k];
      this.headers = h;
      this.headersAt = Date.now();
      for (const w of [...this.headerWaiters]) w();
    }
    let body: { operationName?: unknown; variables?: unknown; extensions?: unknown } | null = null;
    try {
      if (req.method === 'POST' && req.postData) body = JSON.parse(req.postData) as typeof body;
      else if (req.url) {
        const u = new URL(req.url);
        const op = u.searchParams.get('operationName');
        if (op)
          body = {
            operationName: op,
            variables: JSON.parse(u.searchParams.get('variables') ?? '{}'),
            extensions: JSON.parse(u.searchParams.get('extensions') ?? '{}'),
          };
      }
    } catch {
      body = null;
    }
    const name = typeof body?.operationName === 'string' ? body.operationName : null;
    const hash = (body?.extensions as { persistedQuery?: { sha256Hash?: unknown } } | undefined)?.persistedQuery?.sha256Hash;
    if (!name || !/^[A-Za-z0-9_]{1,64}$/.test(name) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return;
    const vars = body?.variables && typeof body.variables === 'object' ? body.variables : {};
    const known = this.repo.op(name);
    if (!known || known.hash !== hash) this.repo.saveOp(name, hash, vars);
    for (const w of [...(this.opWaiters.get(name) ?? [])]) w();
  }

  /* ----------------------------------------------------------------------- query */

  /** Runs one pathfinder operation in the web player tab with `vars` merged over the learned variable template. */
  async query(name: string, vars: Record<string, unknown>): Promise<unknown> {
    await this.ready();
    let op = this.repo.op(name) ?? (await this.learn(name));
    for (let attempt = 0; attempt < 3; attempt++) {
      const template = JSON.parse(op.variables) as Record<string, unknown>;
      const body = {
        variables: { ...template, ...vars },
        operationName: name,
        extensions: { persistedQuery: { version: 1, sha256Hash: op.hash } },
      };
      const res = await this.fetchInPage(PATHFINDER + 'v2/query', body);
      if (res.status === 401 || res.status === 403) {
        await this.reloadForHeaders();
        continue;
      }
      if (res.status === 429) throw new AppError(503, 'rate_limited', 'Spotify is rate limiting this session; try again in a minute.');
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw Errors.upstream(`Spotify answered ${res.status}.`);
      }
      if (isPersistedQueryNotFound(json)) {
        this.repo.forgetOp(name);
        op = await this.learn(name);
        continue;
      }
      if (res.status >= 400) throw Errors.upstream(`Spotify answered ${res.status}.`);
      this.lastUsed = Date.now();
      return json;
    }
    throw Errors.upstream('Spotify kept refusing the request.');
  }

  private async fetchInPage(url: string, body: unknown): Promise<{ status: number; body: string }> {
    if (!this.cdp || !this.sessionId) throw Errors.unavailable('The Spotify browser is not connected.');
    const headers = { ...this.headers, accept: 'application/json', 'content-type': 'application/json;charset=UTF-8' };
    // Everything is passed as JSON literals: no user text is ever spliced into the expression as code.
    const expression = `(async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      try {
        const r = await fetch(${JSON.stringify(url)}, { method: 'POST', headers: ${JSON.stringify(headers)},
          body: ${JSON.stringify(JSON.stringify(body))}, credentials: 'omit', signal: ctl.signal });
        const text = await r.text();
        return { status: r.status, body: text.length > 8000000 ? '' : text };
      } catch (e) { return { status: 0, body: '' }; } finally { clearTimeout(t); }
    })()`;
    const r = await this.cdp.send<{ result?: { value?: { status?: number; body?: string } }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
      25_000,
    );
    const v = r.result?.value;
    if (!v || typeof v.status !== 'number') throw Errors.upstream('The Spotify tab did not answer.');
    if (v.status === 0) throw Errors.upstream('Spotify could not be reached.');
    return { status: v.status, body: typeof v.body === 'string' ? v.body : '' };
  }

  /** Opens the web player page that uses `name` and waits until its request shows up. Serialised per session. */
  private learn(name: string): Promise<{ hash: string; variables: string }> {
    const path = LEARN_URLS[name];
    if (!path) return Promise.reject(Errors.unavailable(`Reddify does not know how to learn ${name}.`));
    const run = this.learning.then(async () => {
      const known = this.repo.op(name);
      if (known) return known;
      this.log(`learning Spotify operation ${name}`);
      const wait = this.waitOp(name, 25_000);
      await this.navigate(path);
      if (!(await wait)) throw Errors.unavailable(`Spotify's web player did not run ${name} (log in first if it needs an account).`);
      return this.repo.op(name)!;
    });
    this.learning = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /* ----------------------------------------------------------------------- login */

  async loggedIn(): Promise<{ loggedIn: boolean }> {
    if (!this.cdp?.isOpen) return { loggedIn: false };
    const { cookies } = await this.cdp.send<{ cookies: { name: string }[] }>('Storage.getCookies', {});
    return { loggedIn: cookies.some((c) => c.name === 'sp_dc') };
  }

  /** Opens Spotify's login page in its own tab (the screen shows it over VNC); closes it once the login cookie exists. */
  async startLogin(): Promise<void> {
    await this.ready();
    const cdp = this.cdp!;
    if (this.loginTarget) await cdp.send('Target.closeTarget', { targetId: this.loginTarget }).catch(() => undefined);
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
      url: 'https://accounts.spotify.com/login?continue=' + encodeURIComponent(ORIGIN + '/'),
    });
    this.loginTarget = targetId;
    if (this.loginPoll) clearInterval(this.loginPoll);
    const started = Date.now();
    this.loginPoll = setInterval(() => {
      void (async () => {
        if (!this.loginTarget || Date.now() - started > 30 * 60_000) return this.finishLogin(false);
        const { loggedIn } = await this.loggedIn().catch(() => ({ loggedIn: false }));
        if (loggedIn) await this.finishLogin(true);
      })();
    }, 3000);
  }

  private async finishLogin(ok: boolean): Promise<void> {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    const t = this.loginTarget;
    this.loginTarget = null;
    if (t) await this.cdp?.send('Target.closeTarget', { targetId: t }).catch(() => undefined);
    if (ok) {
      this.log(`instance ${this.instance}: Spotify login detected`);
      await this.reloadForHeaders().catch(() => undefined);
    }
  }

  /** Signs the browser in with an `sp_dc` cookie copied from the user's own browser (alternative to typing the login). */
  async importCookie(spDc: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{40,600}$/.test(spDc)) throw Errors.badRequest('That does not look like an sp_dc cookie value.');
    await this.ready();
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
    await this.reloadForHeaders();
  }

  async logout(): Promise<void> {
    await this.ready();
    await this.cdp!.send('Storage.clearCookies', {});
    await this.navigate('/');
    this.headers = {};
    await this.waitHeaders(30_000).catch(() => undefined);
  }

  /** Closes the DevTools connection and stops the browser (profile and login stay). */
  async stop(): Promise<void> {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    this.cdp?.close();
    this.cdp = null;
    this.sessionId = null;
    this.headers = {};
    await this.link.stop();
  }

  async restart(): Promise<void> {
    await this.stop().catch(() => undefined);
    await this.ready();
  }
}

/** One SpotifySession per Chromium instance, created on demand; idle browsers are stopped. */
export class SpotifyPool {
  private readonly sessions = new Map<number, SpotifySession>();
  private readonly timer: NodeJS.Timeout | null;

  constructor(
    private readonly repo: Repo,
    private readonly chromiumUrl: string,
    private readonly controlSecret: Buffer,
    idleMinutes: number,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.timer =
      idleMinutes > 0
        ? setInterval(() => {
            const cutoff = Date.now() - idleMinutes * 60_000;
            for (const s of this.sessions.values()) {
              if (s.connected && s.lastUsed < cutoff && !s.loginInProgress) {
                this.log(`instance ${s.instance}: idle, stopping its browser`);
                void s.stop().catch(() => undefined);
              }
            }
          }, 60_000)
        : null;
    this.timer?.unref();
  }

  get(instance: number): SpotifySession {
    let s = this.sessions.get(instance);
    if (!s) {
      s = new SpotifySession(instance, this.repo, this.chromiumUrl, this.controlSecret, this.log);
      this.sessions.set(instance, s);
    }
    return s;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sessions.values()) {
      if (s.connected) void s.stop().catch(() => undefined);
    }
  }
}
