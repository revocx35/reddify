import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthState, Me, SessionInfo } from '../../../shared/api.js';
import { hashPassword, passwordPolicyError, verifyPassword } from '../auth/password.js';
import { provisionOidcUser } from '../auth/provision.js';
import { safeEqual } from '../auth/sessions.js';
import type { AccountLockStore } from '../auth/throttle.js';
import { base32, newTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import type { AppContext } from '../context.js';
import type { SessionRow, UserRow } from '../db/repo.js';
import { Errors } from '../errors.js';
import { cookieName, isSecureRequest, requireUser } from '../http/server.js';

const USERNAME = z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9._-]+$/);

function lockStore(ctx: AppContext, user: UserRow | undefined): AccountLockStore | null {
  if (!user) return null;
  return {
    get: () => {
      const u = ctx.repo.userById(user.id);
      return { failed_logins: u?.failed_logins ?? 0, locked_until: u?.locked_until ?? null };
    },
    set: (p) => ctx.repo.updateUser(user.id, p),
  };
}

export function meOf(user: UserRow, session: SessionRow | null): Me {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    totp: !!user.totp_secret,
    local: !!user.pw_hash,
    oidc: !!user.oidc_sub,
    csrf: session?.kind === 'web' ? session.csrf : '',
  };
}

function setSessionCookie(ctx: AppContext, req: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(cookieName(ctx, req), token, {
    path: '/',
    httpOnly: true,
    secure: isSecureRequest(ctx, req),
    sameSite: 'lax',
    maxAge: ctx.config.sessionAbsoluteDays * 86_400,
  });
}

/* ---------------------------------------------------------------- OIDC state cookie */

const OIDC_COOKIE_SECURE = '__Host-reddify-oidc';
const OIDC_COOKIE_PLAIN = 'reddify-oidc';

function sign(ctx: AppContext, data: string): string {
  return crypto.createHmac('sha256', ctx.config.appKey).update(`oidc|${data}`).digest('base64url');
}

function packState(ctx: AppContext, v: { state: string; verifier: string; nonce: string }): string {
  const data = Buffer.from(JSON.stringify({ ...v, exp: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${data}.${sign(ctx, data)}`;
}

function unpackState(ctx: AppContext, raw: string | undefined): { state: string; verifier: string; nonce: string } | null {
  if (!raw) return null;
  const [data, sig] = raw.split('.');
  if (!data || !sig || !safeEqual(sig, sign(ctx, data))) return null;
  try {
    const v = JSON.parse(Buffer.from(data, 'base64url').toString()) as { state: string; verifier: string; nonce: string; exp: number };
    return v.exp > Date.now() ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ routes */

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pendingTotp = new Map<number, { secret: Buffer; until: number }>();

  app.get('/api/auth/state', async (req): Promise<AuthState> => {
    const users = ctx.repo.countUsers();
    return {
      setupNeeded: users === 0 && ctx.config.localLogin && !!ctx.config.setupToken,
      localLogin: ctx.config.localLogin,
      oidc: { enabled: !!ctx.oidc, label: ctx.config.oidc?.label ?? 'authentik' },
      me: req.auth ? meOf(req.auth.user, req.auth.session) : null,
    };
  });

  /* ------------------------------------------------------------- first admin */
  app.post('/api/auth/setup', async (req, reply) => {
    const body = z
      .object({ setupToken: z.string().max(200), username: USERNAME, password: z.string().max(1024), client: z.enum(['web', 'app']).default('web') })
      .parse(req.body);
    const attempt = ctx.throttle.begin(req.ip, null);
    if (!ctx.config.localLogin || !ctx.config.setupToken || ctx.repo.countUsers() > 0) throw Errors.forbidden('Setup is already done.');
    if (!safeEqual(body.setupToken, ctx.config.setupToken)) throw Errors.unauthorized('Wrong setup token.');
    const policy = passwordPolicyError(body.password, body.username);
    if (policy) throw Errors.badRequest(policy);
    const user = ctx.repo.createUser({ username: body.username, displayName: body.username, role: 'admin', pwHash: await hashPassword(body.password) });
    ctx.throttle.success(attempt);
    ctx.repo.audit('setup', req.ip, user.id);
    return issue(req, reply, user, body.client, 'first login');
  });

  /* --------------------------------------------------------------- password */
  app.post('/api/auth/login', async (req, reply) => {
    const body = z
      .object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(1024),
        totp: z.string().max(12).optional(),
        client: z.enum(['web', 'app']).default('web'),
        label: z.string().max(80).optional(),
      })
      .parse(req.body);
    if (!ctx.config.localLogin) throw Errors.forbidden('Sign in with ' + (ctx.config.oidc?.label ?? 'your identity provider') + '.');
    const user = ctx.repo.userByName(body.username);
    const attempt = ctx.throttle.begin(req.ip, lockStore(ctx, user));
    const ok = await verifyPassword(user?.pw_hash ?? null, body.password);
    if (!user || !ok || user.disabled) {
      ctx.repo.audit('login_failed', req.ip, user?.id ?? null);
      throw Errors.unauthorized('Wrong username or password.');
    }
    if (user.totp_secret) {
      if (!body.totp) return reply.status(401).send({ error: 'totp_required', message: 'Enter the code from your authenticator app.' });
      const step = verifyTotp(user.totp_secret, body.totp, user.totp_last_step);
      if (step === null) {
        ctx.repo.audit('login_failed_totp', req.ip, user.id);
        throw Errors.unauthorized('Wrong code.');
      }
      ctx.repo.updateUser(user.id, { totp_last_step: step });
    }
    ctx.throttle.success(attempt);
    ctx.repo.audit('login', req.ip, user.id);
    return issue(req, reply, user, body.client, body.label ?? (body.client === 'app' ? 'Android' : 'Browser'));
  });

  function issue(req: FastifyRequest, reply: FastifyReply, user: UserRow, client: 'web' | 'app', label: string) {
    // A new session on every login (no fixation); an old cookie of this browser is dropped.
    if (req.auth?.session) ctx.sessions.revoke(req.auth.session.id_hash);
    const { token, row } = ctx.sessions.create(user.id, client, label);
    ctx.repo.updateUser(user.id, { last_seen: Date.now() });
    if (client === 'web') {
      setSessionCookie(ctx, req, reply, token);
      return { me: meOf(user, row), mustChangePassword: user.must_change_pw === 1 };
    }
    return { token, me: meOf(user, row), mustChangePassword: user.must_change_pw === 1 };
  }

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth?.session) ctx.sessions.revoke(req.auth.session.id_hash);
    reply.clearCookie(cookieName(ctx, req), { path: '/' });
    const end = ctx.oidc && req.auth?.user.oidc_sub ? await ctx.oidc.logoutUrl() : null;
    return { ok: true, providerLogout: end };
  });

  /* ------------------------------------------------------------------- OIDC */
  app.get('/api/auth/oidc/start', async (req, reply) => {
    if (!ctx.oidc) throw Errors.notFound();
    const s = await ctx.oidc.start();
    const secure = isSecureRequest(ctx, req);
    reply.setCookie(secure ? OIDC_COOKIE_SECURE : OIDC_COOKIE_PLAIN, packState(ctx, s), {
      path: '/',
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 600,
    });
    return reply.redirect(s.url, 302);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    if (!ctx.oidc) throw Errors.notFound();
    const q = z.object({ code: z.string().max(2048).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const secure = isSecureRequest(ctx, req);
    const name = secure ? OIDC_COOKIE_SECURE : OIDC_COOKIE_PLAIN;
    const st = unpackState(ctx, req.cookies[name]);
    reply.clearCookie(name, { path: '/' });
    if (q.error || !q.code || !q.state || !st || !safeEqual(q.state, st.state)) {
      // The provider's error code (e.g. invalid_request when the provider has no grant types) or which check failed.
      ctx.log(`OIDC callback refused: ${q.error ? `provider said ${q.error.replace(/[^a-z_]/gi, '')}` : !st ? 'no/expired state cookie' : 'state mismatch or no code'}`);
      ctx.repo.audit('oidc_failed', req.ip);
      return reply.redirect('/login?error=oidc', 302);
    }
    const attempt = ctx.throttle.begin(req.ip, null);
    let user: UserRow | null;
    try {
      const id = await ctx.oidc.finish(q.code, st.verifier, st.nonce);
      user = provisionOidcUser(ctx, id, req.ip);
    } catch (e) {
      ctx.log(`OIDC token exchange/verification failed: ${e instanceof Error ? e.message : String(e)}`);
      ctx.repo.audit('oidc_failed', req.ip);
      return reply.redirect('/login?error=oidc', 302);
    }
    if (!user) return reply.redirect('/login?error=disabled', 302);
    ctx.throttle.success(attempt);
    ctx.repo.audit('login_oidc', req.ip, user.id);
    if (req.auth?.session) ctx.sessions.revoke(req.auth.session.id_hash);
    const { token } = ctx.sessions.create(user.id, 'web', 'Browser (authentik)');
    setSessionCookie(ctx, req, reply, token);
    return reply.redirect('/', 302);
  });

  /* ------------------------------------------------------------- own account */
  app.post('/api/me/password', async (req) => {
    const a = requireUser(req);
    const body = z.object({ current: z.string().max(1024).default(''), next: z.string().max(1024) }).parse(req.body);
    const user = ctx.repo.userById(a.user.id)!;
    if (user.pw_hash && !user.must_change_pw) {
      const attempt = ctx.throttle.begin(req.ip, lockStore(ctx, user));
      if (!(await verifyPassword(user.pw_hash, body.current))) throw Errors.unauthorized('The current password is wrong.');
      ctx.throttle.success(attempt);
    } else if (!user.pw_hash) {
      throw Errors.badRequest('This account signs in with ' + (ctx.config.oidc?.label ?? 'SSO') + '.');
    }
    const policy = passwordPolicyError(body.next, user.username);
    if (policy) throw Errors.badRequest(policy);
    ctx.repo.updateUser(user.id, { pw_hash: await hashPassword(body.next), must_change_pw: 0 });
    ctx.repo.deleteUserSessions(user.id, a.session?.id_hash);
    ctx.repo.audit('password_changed', req.ip, user.id);
    return { ok: true };
  });

  app.post('/api/me/totp/setup', async (req) => {
    const a = requireUser(req);
    const secret = newTotpSecret();
    pendingTotp.set(a.user.id, { secret, until: Date.now() + 10 * 60_000 });
    return { secret: base32(secret), url: otpauthUrl(secret, a.user.username) };
  });

  app.post('/api/me/totp/confirm', async (req) => {
    const a = requireUser(req);
    const { code } = z.object({ code: z.string().max(12) }).parse(req.body);
    const p = pendingTotp.get(a.user.id);
    if (!p || p.until < Date.now()) throw Errors.badRequest('Start the setup again.');
    const attempt = ctx.throttle.begin(req.ip, null);
    const step = verifyTotp(p.secret, code, null);
    if (step === null) throw Errors.badRequest('Wrong code; check the time on your phone.');
    ctx.throttle.success(attempt);
    pendingTotp.delete(a.user.id);
    ctx.repo.updateUser(a.user.id, { totp_secret: p.secret, totp_last_step: step });
    ctx.repo.audit('totp_enabled', req.ip, a.user.id);
    return { ok: true };
  });

  app.post('/api/me/totp/disable', async (req) => {
    const a = requireUser(req);
    const { code } = z.object({ code: z.string().max(12) }).parse(req.body);
    const user = ctx.repo.userById(a.user.id)!;
    if (!user.totp_secret) return { ok: true };
    const attempt = ctx.throttle.begin(req.ip, lockStore(ctx, user));
    const step = verifyTotp(user.totp_secret, code, user.totp_last_step);
    if (step === null) throw Errors.unauthorized('Wrong code.');
    ctx.throttle.success(attempt);
    ctx.repo.updateUser(user.id, { totp_secret: null, totp_last_step: null });
    ctx.repo.audit('totp_disabled', req.ip, user.id);
    return { ok: true };
  });

  app.get('/api/me/sessions', async (req): Promise<SessionInfo[]> => {
    const a = requireUser(req);
    return ctx.repo.userSessions(a.user.id).map((s) => ({
      id: s.id_hash.toString('hex').slice(0, 32),
      kind: s.kind,
      label: s.label,
      createdAt: s.created_at,
      lastSeen: s.last_seen,
      current: !!a.session && s.id_hash.equals(a.session.id_hash),
    }));
  });

  app.delete('/api/me/sessions/:id', async (req) => {
    const a = requireUser(req);
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) }).parse(req.params);
    for (const s of ctx.repo.userSessions(a.user.id)) {
      if (s.id_hash.toString('hex').startsWith(id)) ctx.sessions.revoke(s.id_hash);
    }
    return { ok: true };
  });
}
