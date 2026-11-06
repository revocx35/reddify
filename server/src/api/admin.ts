import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminSettings, AdminUser, StorageStats } from '../../../shared/api.js';
import { hashPassword } from '../auth/password.js';
import { type AppContext, instanceFor } from '../context.js';
import type { UserRow } from '../db/repo.js';
import { Errors } from '../errors.js';
import { requireAdmin } from '../http/server.js';

const USERNAME = z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9._-]+$/);

/** A readable random temporary password (shown once to the admin; the user must change it on first login). */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY34679';
  const bytes = crypto.randomBytes(20);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const view = (u: UserRow): AdminUser => ({
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    disabled: u.disabled === 1,
    local: !!u.pw_hash,
    oidc: !!u.oidc_sub,
    totp: !!u.totp_secret,
    createdAt: u.created_at,
    lastSeen: u.last_seen,
    instance: instanceFor(ctx, u),
  });

  app.get('/api/admin/users', async (req): Promise<AdminUser[]> => {
    requireAdmin(req);
    return ctx.repo.listUsers().map(view);
  });

  app.post('/api/admin/users', async (req) => {
    const a = requireAdmin(req);
    const body = z.object({ username: USERNAME, displayName: z.string().trim().max(80).optional(), role: z.enum(['admin', 'user']).default('user') }).parse(req.body);
    if (!ctx.config.localLogin) throw Errors.badRequest('Local accounts are off; users sign in with ' + (ctx.config.oidc?.label ?? 'SSO') + '.');
    if (ctx.repo.userByName(body.username)) throw Errors.conflict('That username is taken.');
    const password = tempPassword();
    const u = ctx.repo.createUser({
      username: body.username,
      displayName: body.displayName || body.username,
      role: body.role,
      pwHash: await hashPassword(password),
      mustChange: true,
    });
    ctx.repo.audit('user_created', req.ip, a.user.id);
    return { user: view(u), temporaryPassword: password };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z
      .object({ role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional(), displayName: z.string().trim().min(1).max(80).optional() })
      .parse(req.body);
    const u = ctx.repo.userById(id);
    if (!u) throw Errors.notFound();
    const demotes = (body.role === 'user' || body.disabled === true) && u.role === 'admin' && !u.disabled;
    if (demotes && ctx.repo.countAdmins() <= 1) throw Errors.conflict('Keep at least one active admin.');
    ctx.repo.updateUser(id, {
      ...(body.role ? { role: body.role } : {}),
      ...(body.disabled !== undefined ? { disabled: body.disabled ? 1 : 0 } : {}),
      ...(body.displayName ? { display_name: body.displayName } : {}),
    });
    if (body.disabled) ctx.repo.deleteUserSessions(id);
    ctx.repo.audit('user_changed', req.ip, a.user.id);
    return view(ctx.repo.userById(id)!);
  });

  app.post('/api/admin/users/:id/reset-password', async (req) => {
    const a = requireAdmin(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const u = ctx.repo.userById(id);
    if (!u) throw Errors.notFound();
    if (!ctx.config.localLogin) throw Errors.badRequest('Local accounts are off.');
    const password = tempPassword();
    ctx.repo.updateUser(id, { pw_hash: await hashPassword(password), must_change_pw: 1, failed_logins: 0, locked_until: null });
    ctx.repo.deleteUserSessions(id);
    ctx.repo.audit('password_reset', req.ip, a.user.id);
    return { temporaryPassword: password };
  });

  app.delete('/api/admin/users/:id', async (req) => {
    const a = requireAdmin(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    if (id === a.user.id) throw Errors.conflict('You cannot delete yourself.');
    const u = ctx.repo.userById(id);
    if (!u) throw Errors.notFound();
    if (u.role === 'admin' && ctx.repo.countAdmins() <= 1) throw Errors.conflict('Keep at least one active admin.');
    await ctx.pool.get(id).stop().catch(() => undefined);
    ctx.repo.deleteUser(id);
    ctx.repo.audit('user_deleted', req.ip, a.user.id);
    return { ok: true };
  });

  app.get('/api/admin/settings', async (req): Promise<AdminSettings> => {
    requireAdmin(req);
    return ctx.repo.adminSettings();
  });

  app.put('/api/admin/settings', async (req): Promise<AdminSettings> => {
    const a = requireAdmin(req);
    const body = z.object({ instanceMode: z.enum(['per-user', 'shared']), sharedInstance: z.number().int().positive() }).parse(req.body);
    if (!ctx.repo.userById(body.sharedInstance)) throw Errors.badRequest('That user does not exist.');
    ctx.repo.setSetting('instance_mode', body.instanceMode);
    ctx.repo.setSetting('shared_instance', String(body.sharedInstance));
    ctx.repo.audit('settings_changed', req.ip, a.user.id);
    return ctx.repo.adminSettings();
  });

  app.get('/api/admin/storage', async (req): Promise<StorageStats> => {
    requireAdmin(req);
    return { ...ctx.repo.storage(), downloading: ctx.downloader.activeCount() };
  });

  app.post('/api/admin/users/:id/browser/stop', async (req) => {
    requireAdmin(req);
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    await ctx.pool.get(id).stop();
    return { ok: true };
  });
}
