import { afterEach, describe, expect, it } from 'vitest';
import type { Track } from '../../../shared/api.js';
import { provisionOidcUser } from '../auth/provision.js';
import { makeApp, cookieOf, setupAdmin, type TestApp } from '../testutil/ctx.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const TRACK = '0DiWol3AO6WpXZgp0goxAV'; // in the getTrack fixture
const ids = ['A', 'B', 'C', 'D'].map((c) => c.repeat(22));
const track = (id: string, n: number): Track => ({
  id,
  name: `Song ${n}`,
  artists: [{ id: 'X'.repeat(22), name: 'Artist' }],
  album: { id: `${n}`.padStart(22, 'a'), name: `Album ${n}` },
  cover: `https://i.scdn.co/image/${n}`,
  durationMs: 60_000,
  explicit: false,
  playable: true,
});

async function signedIn(): Promise<{ h: Record<string, string> }> {
  const s = await setupAdmin(t);
  t.ctx.repo.upsertTracks(ids.map(track));
  return { h: { cookie: s.cookie, 'x-csrf-token': s.csrf } };
}

describe('playlists', () => {
  it('create, add (no duplicates), reorder, remove, rename, delete', async () => {
    t = await makeApp();
    const { h } = await signedIn();
    const c = await t.app.inject({ method: 'POST', url: '/api/playlists', headers: h, payload: {} });
    expect(c.statusCode).toBe(200);
    const p = c.json().playlist;
    expect(p.name).toBe('My Playlist #1');
    expect(p.count).toBe(0);

    const add = await t.app.inject({ method: 'POST', url: `/api/playlists/${p.id}/tracks`, headers: h, payload: { ids: [ids[0], ids[1], ids[2], ids[0]] } });
    expect(add.json().added).toBe(3);
    expect(add.json().playlist.count).toBe(3);
    expect(add.json().playlist.durationMs).toBe(180_000);
    expect(add.json().playlist.covers).toHaveLength(3);
    const again = await t.app.inject({ method: 'POST', url: `/api/playlists/${p.id}/tracks`, headers: h, payload: { ids: [ids[1], ids[3]] } });
    expect(again.json().added).toBe(1);

    const order = async () => (await t.app.inject({ url: `/api/playlists/${p.id}`, headers: h })).json().tracks.map((x: Track) => x.id);
    expect(await order()).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    await t.app.inject({ method: 'PUT', url: `/api/playlists/${p.id}/tracks/${ids[3]}/position`, headers: h, payload: { to: 0 } });
    expect(await order()).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    await t.app.inject({ method: 'PUT', url: `/api/playlists/${p.id}/tracks/${ids[3]}/position`, headers: h, payload: { to: 99 } });
    expect(await order()).toEqual([ids[0], ids[1], ids[2], ids[3]]);
    const rm = await t.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}/tracks/${ids[1]}`, headers: h });
    expect(rm.json().count).toBe(3);
    expect(await order()).toEqual([ids[0], ids[2], ids[3]]);
    // Positions stay dense after a removal: moving to the end still works.
    await t.app.inject({ method: 'PUT', url: `/api/playlists/${p.id}/tracks/${ids[0]}/position`, headers: h, payload: { to: 2 } });
    expect(await order()).toEqual([ids[2], ids[3], ids[0]]);

    const ren = await t.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, headers: h, payload: { name: '  Road\u0000 trip  ', description: 'Summer' } });
    expect(ren.json()).toMatchObject({ name: 'Road trip', description: 'Summer' });
    expect((await t.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, headers: h, payload: { name: '   ' } })).statusCode).toBe(400);
    expect((await t.app.inject({ url: `/api/tracks/${ids[0]}/playlists`, headers: h })).json()).toEqual([p.id]);

    const second = await t.app.inject({ method: 'POST', url: '/api/playlists', headers: h, payload: {} });
    expect(second.json().playlist.name).toBe('My Playlist #1'); // #1 was renamed, so the name is free again
    const lib = await t.app.inject({ url: '/api/library', headers: h });
    expect(lib.json().mine.map((x: { id: number }) => x.id)).toEqual([second.json().playlist.id, p.id]);

    expect((await t.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}`, headers: h })).statusCode).toBe(200);
    expect((await t.app.inject({ url: `/api/playlists/${p.id}`, headers: h })).statusCode).toBe(404);
  });

  it('copies tracks on create and looks up songs Reddify has not seen yet', async () => {
    t = await makeApp();
    const { h } = await signedIn();
    const c = await t.app.inject({ method: 'POST', url: '/api/playlists', headers: h, payload: { name: 'Copy', tracks: [ids[2], TRACK, ids[0]] } });
    expect(c.statusCode).toBe(200);
    expect(c.json().tracks.map((x: Track) => x.id)).toEqual([ids[2], TRACK, ids[0]]);
    expect(t.spotify.calls.filter((x) => x.name === 'getTrack')).toHaveLength(1);
  });

  it("another user's playlist is invisible and untouchable (404), and writes need CSRF", async () => {
    t = await makeApp();
    const { h } = await signedIn();
    const p = (await t.app.inject({ method: 'POST', url: '/api/playlists', headers: h, payload: { name: 'Mine', tracks: [ids[0]] } })).json().playlist;

    const nu = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { username: 'bob', role: 'user' } });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: nu.json().temporaryPassword } });
    const b = cookieOf(login);
    const bh = { cookie: b.cookie, 'x-csrf-token': b.csrf };
    expect((await t.app.inject({ url: `/api/playlists/${p.id}`, headers: bh })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, headers: bh, payload: { name: 'pwned' } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'POST', url: `/api/playlists/${p.id}/tracks`, headers: bh, payload: { ids: [ids[1]] } })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}/tracks/${ids[0]}`, headers: bh })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}`, headers: bh })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/playlists', headers: bh })).json()).toEqual([]);
    expect((await t.app.inject({ url: `/api/tracks/${ids[0]}/playlists`, headers: bh })).json()).toEqual([]);

    const noCsrf = await t.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}`, headers: { cookie: h.cookie! } });
    expect(noCsrf.statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/playlists' })).statusCode).toBe(401);
    expect((await t.app.inject({ url: `/api/playlists/${p.id}`, headers: h })).json().playlist.name).toBe('Mine');
    expect((await t.app.inject({ url: '/api/playlists/abc', headers: h })).statusCode).toBe(400);
  });
});

describe('authentik accounts', () => {
  it('use the authentik username as display name and follow renames', async () => {
    t = await makeApp();
    const u = provisionOidcUser(t.ctx, { sub: 's1', username: 'revocx', name: 'authentik Default Admin', groups: [] }, null)!;
    expect(u.display_name).toBe('revocx');
    t.ctx.repo.updateUser(u.id, { display_name: 'authentik Default Admin' }); // accounts created before the fix
    expect(provisionOidcUser(t.ctx, { sub: 's1', username: 'revocx', name: 'authentik Default Admin', groups: [] }, null)!.display_name).toBe('revocx');
  });
});
