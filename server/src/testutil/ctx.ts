import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from '../api/admin.js';
import { registerAuthRoutes } from '../api/auth.js';
import { registerCatalogRoutes } from '../api/catalog.js';
import { registerPlaybackRoutes } from '../api/playback.js';
import { registerSpotifyRoutes } from '../api/spotify.js';
import { Sessions } from '../auth/sessions.js';
import { Throttle } from '../auth/throttle.js';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { openMemoryDb } from '../db/db.js';
import { Repo } from '../db/repo.js';
import { AppError } from '../errors.js';
import { buildServer } from '../http/server.js';
import { type DownloaderOptions, Downloader } from '../library/downloader.js';
import { Catalog } from '../spotify/catalog.js';
import type { SpotifyPool } from '../spotify/session.js';

export const FIXTURES = path.join(import.meta.dirname, '..', '__fixtures__');
export const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

/** A fake Spotify session: answers pathfinder operations from the captured fixtures (or fails when `offline`). */
export class FakeSpotify {
  offline = false;
  calls: { name: string; vars: Record<string, unknown> }[] = [];
  loggedInValue = false;
  async query(name: string, vars: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, vars });
    if (this.offline) throw new AppError(503, 'unavailable', 'Spotify is down (test)');
    const map: Record<string, string> = {
      home: 'home',
      searchDesktop: 'searchDesktop',
      searchTracks: 'searchTracks',
      getAlbum: 'getAlbum',
      queryArtistOverview: 'queryArtistOverview',
      fetchPlaylist: 'fetchPlaylist',
      getTrack: 'getTrack',
      internalLinkRecommenderTrack: 'internalLinkRecommenderTrack',
    };
    const f = map[name];
    if (!f) throw new AppError(503, 'unavailable', `no fixture for ${name}`);
    return fixture(f);
  }
  async loggedIn() {
    return { loggedIn: this.loggedInValue };
  }
  learnedOps() {
    return ['home'];
  }
  connected = true;
  link = { reachable: async () => true, ensure: async () => true, vncPassword: async () => 'pw' };
  async ready() {}
  async startLogin() {}
  async importCookie() {}
  async logout() {}
  async restart() {}
  async stop() {}
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  spotify: FakeSpotify;
  dir: string;
}

export function testConfig(dir: string, over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    libraryDir: path.join(dir, 'library'),
    webDir: path.join(dir, 'no-web'),
    chromiumUrl: 'http://127.0.0.1:1',
    controlSecret: Buffer.from('x'.repeat(40)),
    appKey: Buffer.alloc(32, 7),
    publicOrigin: null,
    trustProxy: 0,
    cookieSecure: false,
    localLogin: true,
    setupToken: 'setup-token-123',
    oidc: null,
    oidcApp: null,
    ytdlp: 'false',
    python: 'false',
    helperDir: dir,
    maxParallelDownloads: 2,
    browserIdleMinutes: 0,
    sessionIdleMinutes: 60,
    sessionAbsoluteDays: 1,
    ...over,
  };
}

export async function makeApp(over: Partial<Config> = {}, dl: Partial<DownloaderOptions> = {}): Promise<TestApp> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddify-test-'));
  const config = testConfig(dir, over);
  const repo = new Repo(openMemoryDb());
  const spotify = new FakeSpotify();
  const pool = { get: () => spotify, close: () => undefined } as unknown as SpotifyPool;
  const ctx: AppContext = {
    config,
    repo,
    sessions: new Sessions(repo, { idleMs: config.sessionIdleMinutes * 60_000, absoluteMs: config.sessionAbsoluteDays * 86_400_000 }),
    throttle: new Throttle(),
    oidc: null,
    appTokens: null,
    pool,
    catalog: new Catalog(repo, 'UTC'),
    downloader: new Downloader(repo, {
      libraryDir: config.libraryDir,
      ytdlp: 'false',
      python: 'false',
      helperDir: dir,
      maxParallel: 2,
      ...dl,
    }),
    log: () => undefined,
  };
  const app = await buildServer(ctx);
  registerAuthRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerPlaybackRoutes(app, ctx);
  registerSpotifyRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  await app.ready();
  return { app, ctx, spotify, dir };
}

/** Creates the first admin through the setup route and returns its cookie + CSRF token. */
export async function setupAdmin(t: TestApp, username = 'admin', password = 'correct horse battery'): Promise<{ cookie: string; csrf: string }> {
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { setupToken: 'setup-token-123', username, password } });
  if (r.statusCode !== 200) throw new Error(`setup failed: ${r.body}`);
  return cookieOf(r);
}

export function cookieOf(r: { headers: Record<string, unknown>; json: () => unknown }): { cookie: string; csrf: string } {
  const sc = r.headers['set-cookie'];
  const raw = Array.isArray(sc) ? (sc as string[]).find((c) => c.startsWith('reddify=')) : (sc as string);
  const cookie = raw!.split(';')[0]!;
  const csrf = (r.json() as { me: { csrf: string } }).me.csrf;
  return { cookie, csrf };
}
