import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fs from 'node:fs';
import { ZodError } from 'zod';
import type { SessionRow, UserRow } from '../db/repo.js';
import { AppError, Errors } from '../errors.js';
import { safeEqual } from '../auth/sessions.js';
import type { AppContext } from '../context.js';
import { provisionOidcUser } from '../auth/provision.js';

/*
 * Fastify app with the security layer every route relies on:
 *  - who is calling: session cookie (web UI), `X-App-Authorization: Bearer rdf_…` (Android, local accounts) or
 *    `Authorization: Bearer <authentik JWT>` (Android behind authentik) → req.auth
 *  - CSRF: unsafe methods with a cookie need the session's CSRF token in `x-csrf-token` and a same-origin request
 *  - strict headers (CSP without inline script, HSTS, frame denial, no-store on the API), a per-IP request budget
 *  - generic error bodies (no stack traces, no internals)
 */

export interface AuthInfo {
  user: UserRow;
  session: SessionRow | null;
  via: 'cookie' | 'app' | 'jwt';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export const COOKIE_SECURE_NAME = '__Host-reddify';
export const COOKIE_PLAIN_NAME = 'reddify';

export function isSecureRequest(ctx: AppContext, req: FastifyRequest): boolean {
  if (ctx.config.cookieSecure !== 'auto') return ctx.config.cookieSecure;
  return req.protocol === 'https';
}

export function cookieName(ctx: AppContext, req: FastifyRequest): string {
  return isSecureRequest(ctx, req) ? COOKIE_SECURE_NAME : COOKIE_PLAIN_NAME;
}

export function expectedOrigin(ctx: AppContext, req: FastifyRequest): string {
  return ctx.config.publicOrigin ?? `${req.protocol}://${req.host}`;
}

export function requireUser(req: FastifyRequest): AuthInfo {
  if (!req.auth) throw Errors.unauthorized();
  return req.auth;
}

export function requireAdmin(req: FastifyRequest): AuthInfo {
  const a = requireUser(req);
  if (a.user.role !== 'admin') throw Errors.forbidden('Only an admin can do that.');
  return a;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Simple per-IP budget for everything (logins have their own, much stricter throttle). */
class IpBudget {
  private readonly m = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(ip: string, now = Date.now()): boolean {
    let e = this.m.get(ip);
    if (!e || e.reset < now) {
      if (this.m.size > 10_000) this.m.clear();
      e = { n: 0, reset: now + this.windowMs };
      this.m.set(ip, e);
    }
    e.n++;
    return e.n <= this.max;
  }
}

const CSP = [
  "default-src 'self'",
  // The Cast sender SDK (Chrome only) loads from gstatic; no inline script anywhere.
  "script-src 'self' https://www.gstatic.com",
  "style-src 'self'",
  "img-src 'self' data: blob: https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "worker-src 'self' blob:",
].join('; ');

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // Hop count: only the last N proxies (Caddy, then NPM) may speak for the client address.
    trustProxy: (_addr: string, hop: number) => hop < ctx.config.trustProxy,
    bodyLimit: 64 * 1024,
    disableRequestLogging: true, // cast URLs carry a capability; never log URLs
    logger: { level: 'warn' },
    routerOptions: { maxParamLength: 300 },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  app.decorateRequest('auth', null);

  const budget = new IpBudget(1200, 60_000);

  app.addHook('onRequest', async (req, reply) => {
    if (!budget.take(req.ip)) throw Errors.rateLimited(60);
    const secure = isSecureRequest(ctx, req);
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = req.url;
    if (url.startsWith('/api/') && !url.startsWith('/api/stream/') && !url.startsWith('/api/cover/')) {
      reply.header('Cache-Control', 'no-store');
    }
    if (url.startsWith('/api/')) await authenticate(ctx, req);
    // CSRF and cross-site checks for cookie-authenticated state changes and WebSocket upgrades.
    const upgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (UNSAFE.has(req.method) || upgrade) {
      // Browsers label every request; a cross-site one never changes state here (logins included: no login CSRF).
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw Errors.forbidden('Cross-site request refused.');
      const origin = req.headers.origin;
      if (origin && origin !== expectedOrigin(ctx, req)) throw Errors.forbidden('Cross-origin request refused.');
    }
    if (req.auth?.via === 'cookie' && (UNSAFE.has(req.method) || upgrade)) {
      if (upgrade && !req.headers.origin) throw Errors.forbidden('Origin header required.');
      if (!upgrade) {
        const token = req.headers['x-csrf-token'];
        if (typeof token !== 'string' || !req.auth.session || !safeEqual(token, req.auth.session.csrf)) {
          throw Errors.forbidden('Missing or wrong CSRF token. Reload the page.');
        }
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: 'bad_request', message: 'Invalid request.' });
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: 'Invalid request.' });
    }
    ctx.log(`error on ${req.method} ${req.routeOptions.url ?? '?'}: ${err instanceof Error ? err.message : String(err)}`);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong.' });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // Web UI (built by web/, copied to WEB_DIR). index.html for client-side routes.
  if (fs.existsSync(ctx.config.webDir)) {
    await app.register(fastifyStatic, { root: ctx.config.webDir, prefix: '/', index: false, wildcard: false, cacheControl: false });
    const index = fs.readFileSync(`${ctx.config.webDir}/index.html`);
    const sendIndex = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(index);
    app.get('/', sendIndex);
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/cast/') && !/\.[a-z0-9]{2,5}$/i.test(req.url.split('?')[0]!)) {
        return sendIndex(req, reply);
      }
      return reply.status(404).send({ error: 'not_found', message: 'Not found.' });
    });
    app.addHook('onSend', async (req, reply, payload) => {
      if (req.url.startsWith('/assets/')) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return payload;
    });
  }
  return app;
}

/** Resolves req.auth from the cookie, the app token header or an authentik bearer token. Never throws for "none". */
async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<void> {
  // App tokens arrive as X-App-Authorization, or as Authorization after the authentik proxy swapped them back
  // (NPM snippet: the app's own token rides next to the authentik bearer and replaces it upstream).
  const authz0 = req.headers.authorization;
  const appHeader = req.headers['x-app-authorization'] ?? (typeof authz0 === 'string' && /^bearer rdf_/i.test(authz0) ? authz0 : undefined);
  if (typeof appHeader === 'string' && /^bearer /i.test(appHeader)) {
    const found = ctx.sessions.lookup(appHeader.slice(7).trim());
    if (found) req.auth = { user: found.user, session: found.session, via: 'app' };
    return;
  }
  const cookie = req.cookies[COOKIE_SECURE_NAME] ?? req.cookies[COOKIE_PLAIN_NAME];
  if (cookie) {
    const found = ctx.sessions.lookup(cookie);
    if (found) {
      req.auth = { user: found.user, session: found.session, via: 'cookie' };
      return;
    }
  }
  const authz = req.headers.authorization;
  if (ctx.appTokens && typeof authz === 'string' && /^bearer /i.test(authz)) {
    try {
      const id = await ctx.appTokens.verify(authz.slice(7).trim());
      const user = provisionOidcUser(ctx, id, req.ip);
      if (user) {
        if (!user.last_seen || Date.now() - user.last_seen > 60_000) ctx.repo.updateUser(user.id, { last_seen: Date.now() });
        req.auth = { user, session: null, via: 'jwt' };
      }
    } catch {
      /* not ours / invalid: stay anonymous */
    }
  }
}
