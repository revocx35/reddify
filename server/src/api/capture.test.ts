import { afterEach, describe, expect, it } from 'vitest';
import { SpotifyCapture } from '../library/capture.js';
import { makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';
import { stubCapture, type StubCapture } from '../testutil/capture-stub.js';

let t: TestApp | undefined;
let stub: StubCapture | undefined;
afterEach(async () => {
  await t?.app.close();
  await stub?.close();
  t = undefined;
  stub = undefined;
});

describe('admin: audio source and the Spotify engine', () => {
  it('refuses to switch to Spotify when this deployment has no engine, and keeps YouTube Music', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const before = await t.app.inject({ url: '/api/admin/settings', headers: h });
    expect(before.json().audioSource).toBe('youtube');
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: h,
      payload: { instanceMode: 'per-user', sharedInstance: 1, audioSource: 'spotify' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/no Spotify audio engine/i);
    const after = await t.app.inject({ url: '/api/admin/settings', headers: h });
    expect(after.json().audioSource).toBe('youtube');
  });

  it('stores the chosen connection and reports the engine status', async () => {
    stub = await stubCapture({ loggedIn: true });
    t = await makeApp({}, { capture: new SpotifyCapture(stub.url, stub.secret) });
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };

    for (const audioSource of ['spotify', 'youtube-preferred', 'spotify-preferred', 'youtube'] as const) {
      const r = await t.app.inject({
        method: 'PUT',
        url: '/api/admin/settings',
        headers: h,
        payload: { instanceMode: 'per-user', sharedInstance: 1, audioSource },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json().audioSource).toBe(audioSource);
      expect((await t.app.inject({ url: '/api/admin/settings', headers: h })).json().audioSource).toBe(audioSource);
    }

    const st = await t.app.inject({ url: '/api/admin/capture', headers: h });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ configured: true, browser: 'running', loggedIn: true, account: 'Tester' });

    const storage = await t.app.inject({ url: '/api/admin/storage', headers: h });
    expect(storage.json().bySource).toEqual({ youtube: 0, spotify: 0 });
  });

  it('reports an unreachable engine instead of throwing, and stays on YouTube', async () => {
    t = await makeApp({}, { capture: new SpotifyCapture('http://127.0.0.1:1', Buffer.from('k'.repeat(40))) });
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const st = await t.app.inject({ url: '/api/admin/capture', headers: h });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ configured: true, browser: 'unreachable', loggedIn: false });
    const bad = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: h,
      payload: { instanceMode: 'per-user', sharedInstance: 1, audioSource: 'spotify-preferred' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('is admin-only', async () => {
    t = await makeApp();
    const s = await setupAdmin(t);
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { username: 'bob', role: 'user' },
    });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: 'x' } });
    expect(login.statusCode).toBeGreaterThanOrEqual(400);
    const anon = await t.app.inject({ url: '/api/admin/capture' });
    expect(anon.statusCode).toBe(401);
  });
});
