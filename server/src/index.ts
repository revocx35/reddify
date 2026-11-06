import path from 'node:path';
import { registerAdminRoutes } from './api/admin.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerCatalogRoutes } from './api/catalog.js';
import { registerPlaybackRoutes } from './api/playback.js';
import { registerPlaylistRoutes } from './api/playlists.js';
import { registerSpotifyRoutes } from './api/spotify.js';
import { AppTokenVerifier, OidcClient } from './auth/oidc.js';
import { Sessions } from './auth/sessions.js';
import { Throttle } from './auth/throttle.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDb } from './db/db.js';
import { Repo } from './db/repo.js';
import { buildServer } from './http/server.js';
import { Downloader } from './library/downloader.js';
import { Catalog } from './spotify/catalog.js';
import { SpotifyPool } from './spotify/session.js';

const log = (msg: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
};

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = new Repo(openDb(config.dataDir));
  const sessions = new Sessions(repo, {
    idleMs: config.sessionIdleMinutes * 60_000,
    absoluteMs: config.sessionAbsoluteDays * 86_400_000,
  });
  const ctx: AppContext = {
    config,
    repo,
    sessions,
    throttle: new Throttle(),
    oidc: config.oidc ? new OidcClient(config.oidc, `${config.publicOrigin}/api/auth/oidc/callback`) : null,
    appTokens: config.oidcApp ? new AppTokenVerifier(config.oidcApp) : null,
    pool: new SpotifyPool(repo, config.chromiumUrl, config.controlSecret, config.browserIdleMinutes, log),
    catalog: new Catalog(repo, process.env.TZ || 'UTC'),
    downloader: new Downloader(repo, {
      libraryDir: config.libraryDir,
      ytdlp: config.ytdlp,
      python: config.python,
      helperDir: config.helperDir,
      maxParallel: config.maxParallelDownloads,
      log,
    }),
    log,
  };
  const app = await buildServer(ctx);
  registerAuthRoutes(app, ctx);
  registerCatalogRoutes(app, ctx);
  registerPlaybackRoutes(app, ctx);
  registerPlaylistRoutes(app, ctx);
  registerSpotifyRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  setInterval(() => sessions.prune(), 3600_000).unref();
  await app.listen({ port: config.port, host: config.host });
  log(
    `Reddify listening on ${config.host}:${config.port} (library ${path.resolve(config.libraryDir)}, OIDC ${config.oidc ? 'on' : 'off'}, local login ${config.localLogin ? 'on' : 'off'})`,
  );
  if (repo.countUsers() === 0 && !config.oidc && !config.setupToken) log('No users and no SETUP_TOKEN/OIDC: nobody can sign in. Run scripts/setup.sh.');
  const stop = async (): Promise<void> => {
    log('stopping');
    ctx.pool.close();
    await app.close();
    repo.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

main().catch((e: unknown) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
