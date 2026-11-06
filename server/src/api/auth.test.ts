import { afterEach, describe, expect, it } from 'vitest';
import { cookieOf, makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

describe('auth', () => {
  it('setup creates the first admin once; wrong setup token is refused', async () => {
    t = await makeApp();
    const bad = await t.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { setupToken: 'nope', username: 'admin', password: 'correct horse battery' } });
    expect(bad.statusCode).toBe(401);
    const s = await setupAdmin(t);
    expect(s.csrf.length).toBeGreaterThan(10);
    const again = await t.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { setupToken: 'setup-token-123', username: 'x2', password: 'correct horse battery' } });
    expect(again.statusCode).toBe(403);
    const state = await t.app.inject({ url: '/api/auth/state', headers: { cookie: s.cookie } });
    expect(state.json().me.role).toBe('admin');
    expect(state.json().setupNeeded).toBe(false);
  });

  it('rejects weak passwords at setup', async () => {
    t = await makeApp();
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { setupToken: 'setup-token-123', username: 'admin', password: 'short' } });
    expect(r.statusCode).toBe(400);
  });

  it('wrong password: generic 401 for unknown user and wrong password alike', async () => {
    t = await makeApp();
    await setupAdmin(t);
    const a = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong password!!' } });
    const b = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'ghost', password: 'wrong password!!' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it('locks an IP out after repeated failures (429 with Retry-After), even for the right password', async () => {
    t = await makeApp();
    await setupAdmin(t);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'wrong password!!' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes).toContain(429);
    const ok = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery' } });
    expect(ok.statusCode).toBe(429);
    expect(ok.headers['retry-after']).toBeDefined();
  });

  it('CSRF: a cookie-authenticated change without the token is refused; with it, allowed', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    const no = await t.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: s.cookie }, payload: { instanceMode: 'shared', sharedInstance: 1 } });
    expect(no.statusCode).toBe(403);
    const wrong = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: s.cookie, 'x-csrf-token': 'x'.repeat(32) },
      payload: { instanceMode: 'shared', sharedInstance: 1 },
    });
    expect(wrong.statusCode).toBe(403);
    const yes = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { instanceMode: 'shared', sharedInstance: 1 },
    });
    expect(yes.statusCode).toBe(200);
    expect(yes.json().instanceMode).toBe('shared');
  });

  it('refuses cross-site state changes, even logins', async () => {
    t = await makeApp();
    await setupAdmin(t);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'sec-fetch-site': 'cross-site' },
      payload: { username: 'admin', password: 'correct horse battery' },
    });
    expect(r.statusCode).toBe(403);
    const o = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { username: 'admin', password: 'correct horse battery' },
    });
    expect(o.statusCode).toBe(403);
  });

  it('bad or missing token → 401; app tokens work without CSRF; logout really ends the session', async () => {
    t = await makeApp();
    await setupAdmin(t);
    expect((await t.app.inject({ url: '/api/home' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/home', headers: { 'x-app-authorization': 'Bearer rdf_bogus' } })).statusCode).toBe(401);
    expect((await t.app.inject({ url: '/api/home', headers: { cookie: 'reddify=rdf_' + 'A'.repeat(43) } })).statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery', client: 'app' } });
    const token = login.json().token as string;
    expect(token).toMatch(/^rdf_/);
    const h = { 'x-app-authorization': `Bearer ${token}` };
    expect((await t.app.inject({ url: '/api/home', headers: h })).statusCode).toBe(200);
    // The same token after the authentik proxy moved it into Authorization.
    expect((await t.app.inject({ url: '/api/home', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'PUT', url: '/api/library/liked/0DiWol3AO6WpXZgp0goxAV', headers: h })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/api/home', headers: h })).statusCode).toBe(401);
  });

  it('expired sessions are rejected and deleted', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    t.ctx.repo.db.prepare('UPDATE sessions SET last_seen = last_seen - ?').run(2 * 3600_000);
    expect((await t.app.inject({ url: '/api/home', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    expect((t.ctx.repo.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
  });

  it('TOTP: enrol, then login needs the code; replay of the same code is refused', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const setup = await t.app.inject({ method: 'POST', url: '/api/me/totp/setup', headers: h });
    const { hotp, currentStep } = await import('../auth/totp.js');
    const { secret } = setup.json() as { secret: string };
    const raw = base32Decode(secret);
    const code = hotp(raw, currentStep());
    expect((await t.app.inject({ method: 'POST', url: '/api/me/totp/confirm', headers: h, payload: { code } })).statusCode).toBe(200);
    const need = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery' } });
    expect(need.json().error).toBe('totp_required');
    const replay = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'correct horse battery', totp: code } });
    expect(replay.statusCode).toBe(401);
  });

  it('admin creates a user with a temporary password that must be changed; non-admins get 403', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const c = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { username: 'friend' } });
    expect(c.statusCode).toBe(200);
    const temp = c.json().temporaryPassword as string;
    const l = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'friend', password: temp } });
    expect(l.json().mustChangePassword).toBe(true);
    const f = cookieOf(l);
    expect((await t.app.inject({ url: '/api/admin/users', headers: { cookie: f.cookie } })).statusCode).toBe(403);
    const ch = await t.app.inject({
      method: 'POST',
      url: '/api/me/password',
      headers: { cookie: f.cookie, 'x-csrf-token': f.csrf },
      payload: { next: 'a much better passphrase' },
    });
    expect(ch.statusCode).toBe(200);
    // Last admin cannot be demoted.
    const d = await t.app.inject({ method: 'PATCH', url: '/api/admin/users/1', headers: h, payload: { role: 'user' } });
    expect(d.statusCode).toBe(409);
  });

  it('sends strict security headers', async () => {
    t = await makeApp();
    const r = await t.app.inject({ url: '/api/auth/state' });
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});

function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
