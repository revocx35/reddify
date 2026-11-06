import { Errors } from '../errors.js';

/*
 * Brute-force throttling for every credential check (password, TOTP).
 *
 * - Each attempt is *charged before* the slow hash runs, synchronously (better-sqlite3 is synchronous, so there is no
 *   await between check and write): parallel requests cannot race past a lock. Success refunds by resetting.
 * - Per IP: after IP_THRESHOLD failures, exponentially growing locks (30 s … 1 h).
 * - Per account (persisted on the user row): after ACCOUNT_THRESHOLD consecutive failures from anywhere, one attempt
 *   per lock period (30 s … 15 min). An attacker cannot lock the owner out for long, and distributed guessing is
 *   bounded to roughly a hundred attempts a day.
 */

const IP_THRESHOLD = 5;
const IP_BASE_MS = 30_000;
const IP_MAX_MS = 60 * 60_000;
const ACCOUNT_THRESHOLD = 10;
const ACCOUNT_BASE_MS = 30_000;
const ACCOUNT_MAX_MS = 15 * 60_000;
const IP_ENTRY_TTL_MS = 24 * 3600_000;

interface IpState {
  fails: number;
  lockedUntil: number;
  last: number;
}

export interface AccountLock {
  failed_logins: number;
  locked_until: number | null;
}

/** Where an account's counters live (the users table). */
export interface AccountLockStore {
  get(): AccountLock;
  set(patch: AccountLock): void;
}

export interface Attempt {
  ip: string;
  account: AccountLockStore | null;
}

function backoff(n: number, threshold: number, base: number, max: number): number {
  return Math.min(base * 2 ** Math.max(0, n - threshold - 1), max);
}

export class Throttle {
  private readonly ips = new Map<string, IpState>();

  /** Charges one attempt. Throws a 429 AppError when the IP or the account is locked. */
  begin(ip: string | null | undefined, account: AccountLockStore | null, now = Date.now()): Attempt {
    const key = ip || 'unknown';
    this.prune(now);
    let st = this.ips.get(key) ?? { fails: 0, lockedUntil: 0, last: now };
    if (st.lockedUntil <= now && now - st.last > IP_ENTRY_TTL_MS) st = { fails: 0, lockedUntil: 0, last: now };
    if (st.lockedUntil > now) throw Errors.rateLimited((st.lockedUntil - now) / 1000);
    if (account) {
      const lock = account.get();
      if (lock.locked_until && lock.locked_until > now) throw Errors.rateLimited((lock.locked_until - now) / 1000);
      const n = lock.failed_logins + 1;
      account.set({
        failed_logins: n,
        locked_until: n > ACCOUNT_THRESHOLD ? now + backoff(n, ACCOUNT_THRESHOLD, ACCOUNT_BASE_MS, ACCOUNT_MAX_MS) : lock.locked_until,
      });
    }
    st.fails += 1;
    st.last = now;
    if (st.fails > IP_THRESHOLD) st.lockedUntil = now + backoff(st.fails, IP_THRESHOLD, IP_BASE_MS, IP_MAX_MS);
    this.ips.set(key, st);
    return { ip: key, account };
  }

  /** Credentials were fully verified: clear the counters this attempt charged. */
  success(a: Attempt): void {
    this.ips.delete(a.ip);
    a.account?.set({ failed_logins: 0, locked_until: null });
  }

  private prune(now: number): void {
    if (this.ips.size < 5000) return;
    for (const [k, v] of this.ips) if (now - v.last > IP_ENTRY_TTL_MS && v.lockedUntil < now) this.ips.delete(k);
  }
}
