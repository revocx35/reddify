import crypto from 'node:crypto';
import path from 'node:path';

/** All runtime settings, read once from the environment (see .env.example and ARCHITECTURE.md §Configuration). */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  libraryDir: string;
  webDir: string;
  /** Chromium manager (chromium container). */
  chromiumUrl: string;
  /** Capture container (Chrome + Widevine + virtual speaker), or null when this deployment has none. */
  captureUrl: string | null;
  controlSecret: Buffer;
  /** Key for cast URLs and other HMACs inside the app (derived from CONTROL_SECRET). */
  appKey: Buffer;
  /** https://reddify.example.com — required for OIDC and cast URLs; pins the Origin check when set. */
  publicOrigin: string | null;
  /** How many reverse proxies in front of the app may set X-Forwarded-For (1 = Caddy, 2 = Caddy + NPM). */
  trustProxy: number;
  cookieSecure: 'auto' | boolean;
  localLogin: boolean;
  /** One-time token that allows creating the first admin account (printed by scripts/setup.sh). */
  setupToken: string | null;
  oidc: OidcConfig | null;
  /** Bearer tokens of the Android client's own authentik provider (verified as JWTs). */
  oidcApp: { issuer: string; clientId: string } | null;
  ytdlp: string;
  python: string;
  helperDir: string;
  maxParallelDownloads: number;
  /** Stop a user's Chromium after this many minutes without Spotify queries (0 = never). */
  browserIdleMinutes: number;
  /** Minutes until a session expires without use / in any case. */
  sessionIdleMinutes: number;
  sessionAbsoluteDays: number;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  adminGroup: string;
  /** Only needed when the app cannot reach the issuer's public address (hairpin NAT). Same TLS name is kept. */
}

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const v = Number(env(name));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

function origin(v: string | undefined): string | null {
  if (!v) return null;
  const u = new URL(v);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('PUBLIC_ORIGIN must be an http(s) URL');
  return u.origin;
}

export function loadConfig(): Config {
  const secret = env('CONTROL_SECRET');
  if (!secret || secret.length < 32) throw new Error('CONTROL_SECRET must be set (at least 32 characters): run scripts/setup.sh');
  const controlSecret = Buffer.from(secret, 'utf8');
  const appKey = Buffer.from(crypto.hkdfSync('sha256', controlSecret, Buffer.alloc(0), 'reddify/app-key', 32));
  const dataDir = env('DATA_DIR', '/data')!;
  const issuer = env('OIDC_ISSUER');
  const clientId = env('OIDC_CLIENT_ID');
  const clientSecret = env('OIDC_CLIENT_SECRET');
  const oidc =
    issuer && clientId && clientSecret
      ? {
          issuer: issuer.replace(/\/+$/, '') + '/',
          clientId,
          clientSecret,
          label: env('OIDC_LABEL', 'authentik')!,
          adminGroup: env('OIDC_ADMIN_GROUP', 'authentik Admins')!,
        }
      : null;
  const appIssuer = env('OIDC_APP_ISSUER');
  const appClient = env('OIDC_APP_CLIENT_ID');
  const publicOrigin = origin(env('PUBLIC_ORIGIN'));
  if (oidc && !publicOrigin) throw new Error('OIDC needs PUBLIC_ORIGIN (the redirect URI is built from it)');
  const cs = env('COOKIE_SECURE', 'auto')!;
  return {
    port: int('PORT', 8080, 1, 65535),
    host: env('HOST', '0.0.0.0')!,
    dataDir,
    libraryDir: env('LIBRARY_DIR', path.join(dataDir, 'library'))!,
    webDir: env('WEB_DIR', path.resolve('web'))!,
    chromiumUrl: env('CHROMIUM_URL', 'http://chromium:9223')!.replace(/\/+$/, ''),
    captureUrl: (env('CAPTURE_URL', 'http://capture:9224') ?? '').replace(/\/+$/, '') || null,
    controlSecret,
    appKey,
    publicOrigin,
    trustProxy: int('TRUST_PROXY', 1, 0, 5),
    cookieSecure: cs === 'auto' ? 'auto' : /^(1|true|yes)$/i.test(cs),
    localLogin: bool('LOCAL_LOGIN', true),
    setupToken: env('SETUP_TOKEN') ?? null,
    oidc,
    oidcApp: appIssuer && appClient ? { issuer: appIssuer.replace(/\/+$/, '') + '/', clientId: appClient } : null,
    ytdlp: env('YTDLP_BIN', 'yt-dlp')!,
    python: env('PYTHON_BIN', 'python3')!,
    helperDir: env('HELPER_DIR', path.resolve('py'))!,
    maxParallelDownloads: int('MAX_PARALLEL_DOWNLOADS', 3, 1, 8),
    browserIdleMinutes: int('BROWSER_IDLE_MINUTES', 120, 0, 10_080),
    sessionIdleMinutes: int('SESSION_IDLE_MINUTES', 60 * 24 * 14, 5, 60 * 24 * 365),
    sessionAbsoluteDays: int('SESSION_ABSOLUTE_DAYS', 90, 1, 400),
  };
}
