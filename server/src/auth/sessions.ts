import crypto from 'node:crypto';
import type { Repo, SessionRow, UserRow } from '../db/repo.js';

/*
 * Sessions: a random 256-bit token goes to the client (cookie for the web UI, `X-App-Authorization: Bearer rdf_…` for
 * the Android client); only its SHA-256 is stored. Every session has an idle timeout and an absolute lifetime, a
 * per-session CSRF token, and is deleted on logout, password change (others) and when the user is disabled.
 */

export const TOKEN_PREFIX = 'rdf_';

export function newToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): Buffer {
  return crypto.createHash('sha256').update(token).digest();
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
}

export class Sessions {
  constructor(
    private readonly repo: Repo,
    private readonly policy: SessionPolicy,
  ) {}

  create(userId: number, kind: 'web' | 'app', label: string): { token: string; row: SessionRow } {
    const token = newToken();
    const now = Date.now();
    const row: SessionRow = {
      id_hash: tokenHash(token),
      user_id: userId,
      kind,
      label: label.slice(0, 80),
      csrf: crypto.randomBytes(24).toString('base64url'),
      created_at: now,
      last_seen: now,
      expires_at: now + this.policy.absoluteMs,
    };
    this.repo.insertSession(row);
    return { token, row };
  }

  /** The session and its (enabled) user for a presented token, or null. Touches last_seen at most once a minute. */
  lookup(token: string, now = Date.now()): { session: SessionRow; user: UserRow } | null {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return null;
    const session = this.repo.session(tokenHash(token));
    if (!session) return null;
    if (session.expires_at < now || session.last_seen < now - this.policy.idleMs) {
      this.repo.deleteSession(session.id_hash);
      return null;
    }
    const user = this.repo.userById(session.user_id);
    if (!user || user.disabled) return null;
    if (now - session.last_seen > 60_000) {
      this.repo.touchSession(session.id_hash, now);
      this.repo.updateUser(user.id, { last_seen: now });
    }
    return { session, user };
  }

  revoke(idHash: Buffer): void {
    this.repo.deleteSession(idHash);
  }

  prune(): void {
    this.repo.pruneSessions(Date.now(), this.policy.idleMs);
  }
}
