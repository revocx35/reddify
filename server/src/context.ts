import type { Config } from './config.js';
import type { Repo, UserRow } from './db/repo.js';
import type { AppTokenVerifier, OidcClient } from './auth/oidc.js';
import type { Sessions } from './auth/sessions.js';
import type { Throttle } from './auth/throttle.js';
import type { Downloader } from './library/downloader.js';
import type { SpotifyCapture } from './library/capture.js';
import type { Catalog } from './spotify/catalog.js';
import type { SpotifyPool } from './spotify/session.js';

export interface AppContext {
  config: Config;
  repo: Repo;
  sessions: Sessions;
  throttle: Throttle;
  oidc: OidcClient | null;
  appTokens: AppTokenVerifier | null;
  pool: SpotifyPool;
  catalog: Catalog;
  downloader: Downloader;
  /** The Spotify audio engine (capture container); `configured` is false when the deployment has none. */
  capture: SpotifyCapture;
  log: (msg: string) => void;
}

/** The Chromium instance a user's Spotify requests go through (admin setting: own browser, or one shared browser). */
export function instanceFor(ctx: AppContext, user: Pick<UserRow, 'id'>): number {
  const s = ctx.repo.adminSettings();
  if (s.instanceMode === 'shared') {
    return ctx.repo.userById(s.sharedInstance) ? s.sharedInstance : 1;
  }
  return user.id;
}
