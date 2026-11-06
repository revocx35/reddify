import crypto from 'node:crypto';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { OidcConfig } from '../config.js';
import { Errors } from '../errors.js';

/*
 * OpenID Connect against authentik (or any OIDC provider):
 *  - Web UI: authorization code flow with PKCE (S256), state and nonce, confidential client; the ID token is verified
 *    (signature via JWKS, issuer, audience, expiry, nonce). The transient state lives in a short-lived, HttpOnly,
 *    SameSite=Lax cookie that is bound to the browser (HMAC with the app key) and deleted after the callback.
 *  - Android client: `Authorization: Bearer <access token>` issued by its own public PKCE provider; verified as a
 *    JWT against that provider's JWKS (issuer + audience/azp = its client id).
 */

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface OidcIdentity {
  sub: string;
  username: string;
  name: string;
  groups: string[];
}

async function discover(issuer: string): Promise<Discovery> {
  const r = await fetch(new URL('.well-known/openid-configuration', issuer), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!r.ok) throw Errors.unavailable('The sign-in provider is not reachable.');
  const d = (await r.json()) as Discovery;
  if (d.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw Errors.unavailable('The sign-in provider has an unexpected issuer.');
  for (const u of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
    if (typeof u !== 'string' || !u.startsWith('https://')) throw Errors.unavailable('The sign-in provider configuration is not https.');
  }
  return d;
}

export function identityFrom(payload: JWTPayload): OidcIdentity {
  const p = payload as JWTPayload & { preferred_username?: unknown; name?: unknown; groups?: unknown; email?: unknown };
  const sub = typeof p.sub === 'string' ? p.sub : '';
  if (!sub || sub.length > 255) throw Errors.unauthorized('The sign-in provider sent no subject.');
  const raw = typeof p.preferred_username === 'string' ? p.preferred_username : typeof p.email === 'string' ? p.email.split('@')[0]! : 'user';
  const username = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32) || 'user';
  return {
    sub,
    username,
    name: (typeof p.name === 'string' && p.name.trim() ? p.name : username).slice(0, 80),
    groups: Array.isArray(p.groups) ? p.groups.filter((g): g is string => typeof g === 'string').slice(0, 100) : [],
  };
}

export class OidcClient {
  private disc: Promise<Discovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    readonly cfg: OidcConfig,
    private readonly redirectUri: string,
  ) {}

  private discovery(): Promise<Discovery> {
    this.disc ??= discover(this.cfg.issuer).catch((e: unknown) => {
      this.disc = null;
      throw e;
    });
    return this.disc;
  }

  /** Builds the authorize URL; the returned state blob must be kept (cookie) until the callback. */
  async start(): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const d = await this.discovery();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.toString(), state, verifier, nonce };
  }

  async finish(code: string, verifier: string, nonce: string): Promise<OidcIdentity> {
    const d = await this.discovery();
    const r = await fetch(d.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier }),
    });
    if (!r.ok) throw Errors.unauthorized('The sign-in provider refused the login.');
    const tok = (await r.json()) as { id_token?: unknown };
    if (typeof tok.id_token !== 'string') throw Errors.unauthorized('The sign-in provider sent no ID token.');
    this.jwks ??= createRemoteJWKSet(new URL(d.jwks_uri));
    const { payload } = await jwtVerify(tok.id_token, this.jwks, {
      issuer: d.issuer,
      audience: this.cfg.clientId,
      clockTolerance: 30,
    }).catch(() => {
      throw Errors.unauthorized('The ID token is not valid.');
    });
    if (payload.nonce !== nonce) throw Errors.unauthorized('The sign-in response does not belong to this login.');
    return identityFrom(payload);
  }

  async logoutUrl(): Promise<string | null> {
    const d = await this.discovery().catch(() => null);
    return d?.end_session_endpoint ?? null;
  }
}

/** Verifies the Android client's access tokens (JWTs of its own authentik provider). */
export class AppTokenVerifier {
  private disc: Promise<Discovery> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly cfg: { issuer: string; clientId: string }) {}

  async verify(token: string): Promise<OidcIdentity> {
    if (token.length > 8192 || token.split('.').length !== 3) throw Errors.unauthorized();
    this.disc ??= discover(this.cfg.issuer).catch((e: unknown) => {
      this.disc = null;
      throw e;
    });
    const d = await this.disc;
    this.jwks ??= createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
    const { payload } = await jwtVerify(token, this.jwks, { issuer: d.issuer, clockTolerance: 30 }).catch(() => {
      throw Errors.unauthorized('The sign-in token is not valid.');
    });
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const azp = (payload as { azp?: unknown }).azp;
    if (!aud.includes(this.cfg.clientId) && azp !== this.cfg.clientId) throw Errors.unauthorized('The sign-in token is for another app.');
    return identityFrom(payload);
  }
}
