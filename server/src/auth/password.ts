import { hash, verify } from '@node-rs/argon2';

/** argon2id, OWASP 2025 baseline (19 MiB, t=2, p=1). Parameters are stored in the hash string. */
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, algorithm: 2 /* Argon2id */ } as const;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

// Verified against when the username is unknown, so a miss costs the same time as a wrong password.
let dummyHash: Promise<string> | null = null;

export function normalizePassword(pw: string): string {
  return pw.normalize('NFKC');
}

export function hashPassword(pw: string): Promise<string> {
  return hash(normalizePassword(pw), OPTS);
}

export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (pw.length > PASSWORD_MAX * 4) return false;
  if (!stored) {
    dummyHash ??= hash('reddify-dummy-password', OPTS);
    await verify(await dummyHash, normalizePassword(pw)).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, normalizePassword(pw));
  } catch {
    return false;
  }
}

const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', '1234567890123', 'qwertyuiopas', 'qwerty123456',
  'iloveyou1234', 'letmein12345', 'administrator', 'passw0rd1234', 'spotify12345', 'reddify12345', 'welcome12345',
  'changeme1234', 'aaaaaaaaaaaa', '111111111111', '000000000000', 'abcdefghijkl', 'abc123abc123',
]);

/** A user-facing reason when the password is unacceptable, else null. */
export function passwordPolicyError(pw: string, username: string): string | null {
  const p = normalizePassword(pw);
  if ([...p].length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  const lower = p.toLowerCase();
  if (username.length >= 3 && lower.includes(username.toLowerCase())) return 'Password must not contain the username.';
  if (COMMON.has(lower)) return 'This password is too common.';
  if (new Set(lower).size < 5) return 'Password is too repetitive.';
  return null;
}
