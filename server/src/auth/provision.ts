import type { UserRow } from '../db/repo.js';
import type { AppContext } from '../context.js';
import type { OidcIdentity } from './oidc.js';

/**
 * The Reddify user for an authentik identity: found by `sub`, else created (who may sign in at all is decided by the
 * authentik application's bindings). The first account ever becomes admin; so does anyone in OIDC_ADMIN_GROUP.
 * The display name is the authentik username (`preferred_username`), refreshed on every sign-in: authentik's `name`
 * is often a placeholder ("authentik Default Admin"). Returns null for a disabled user.
 */
export function provisionOidcUser(ctx: AppContext, id: OidcIdentity, ip: string | null): UserRow | null {
  const adminGroup = ctx.config.oidc?.adminGroup;
  const isAdminByGroup = !!adminGroup && id.groups.includes(adminGroup);
  let user = ctx.repo.userBySub(id.sub);
  if (!user) {
    let name = id.username;
    for (let i = 2; ctx.repo.userByName(name); i++) name = `${id.username.slice(0, 28)}${i}`;
    const first = ctx.repo.countUsers() === 0;
    user = ctx.repo.createUser({ username: name, displayName: id.username, role: first || isAdminByGroup ? 'admin' : 'user', oidcSub: id.sub });
    ctx.repo.audit('user_created_oidc', ip, user.id);
  } else {
    const patch: Parameters<typeof ctx.repo.updateUser>[1] = {};
    if (isAdminByGroup && user.role !== 'admin') patch.role = 'admin';
    if (id.username && user.display_name !== id.username) patch.display_name = id.username;
    if (Object.keys(patch).length) {
      ctx.repo.updateUser(user.id, patch);
      user = ctx.repo.userById(user.id)!;
    }
  }
  return user.disabled ? null : user;
}
