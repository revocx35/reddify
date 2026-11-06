import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, cookieOf, setupAdmin, type TestApp } from '../testutil/ctx.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const PL = 'P'.repeat(22);
const AL = 'Q'.repeat(22);
const AR = 'R'.repeat(22);
const libraryV3 = {
  data: {
    me: {
      libraryV3: {
        items: [
          { item: { data: { __typename: 'Playlist', uri: `spotify:playlist:${PL}`, name: 'Road trip', ownerV2: { data: { name: 'me' } } } } },
          { item: { data: { __typename: 'Album', uri: `spotify:album:${AL}`, name: 'An album', artists: { items: [] } } } },
          { item: { data: { __typename: 'Artist', uri: `spotify:artist:${AR}`, profile: { name: 'An artist' } } } },
        ],
      },
    },
  },
};

async function signedIn(): Promise<Record<string, string>> {
  const s = await setupAdmin(t);
  t.spotify.loggedInValue = true;
  t.spotify.answers.libraryV3 = libraryV3;
  return { cookie: s.cookie, 'x-csrf-token': s.csrf };
}

describe('Your Library: remove in Reddify only', () => {
  it('hides a Spotify item without telling Spotify, lists it as hidden, and restores it', async () => {
    t = await makeApp();
    const h = await signedIn();
    const lib = async () => (await t.app.inject({ url: '/api/library', headers: h })).json();
    expect((await lib()).playlists.map((c: { id: string }) => c.id)).toEqual([PL, AL, AR]);

    const before = t.spotify.calls.length;
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/album/${AL}`, headers: h })).statusCode).toBe(200);
    // Only the (cached) library read: no write operation reached Spotify.
    expect(t.spotify.calls.slice(before).every((c) => c.name === 'libraryV3')).toBe(true);

    const after = await lib();
    expect(after.playlists.map((c: { id: string }) => c.id)).toEqual([PL, AR]);
    expect(after.hidden).toEqual([{ kind: 'album', id: AL, name: 'An album', subtitle: '', image: null }]);

    // Still listed (and restorable) while Spotify is down.
    t.spotify.offline = true;
    expect((await lib()).hidden).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/library/hidden/album/${AL}`, headers: h })).statusCode).toBe(200);
    t.spotify.offline = false;
    const back = await lib();
    expect(back.hidden).toEqual([]);
    expect(back.playlists.map((c: { id: string }) => c.id)).toEqual([PL, AL, AR]);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/library/hidden/album/${AL}`, headers: h })).statusCode).toBe(404);
  });

  it('only hides items really in the library, validates input, needs CSRF, and is per user', async () => {
    t = await makeApp();
    const h = await signedIn();
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/playlist/${'Z'.repeat(22)}`, headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/album/${PL}`, headers: h })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/track/${PL}`, headers: h })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: '/api/library/hidden/playlist/abc', headers: h })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/playlist/${PL}`, headers: { cookie: h.cookie! } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/playlist/${PL}` })).statusCode).toBe(401);

    expect((await t.app.inject({ method: 'PUT', url: `/api/library/hidden/playlist/${PL}`, headers: h })).statusCode).toBe(200);
    const nu = await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: h, payload: { username: 'bob', role: 'user' } });
    const login = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'bob', password: nu.json().temporaryPassword } });
    const b = cookieOf(login);
    const bob = (await t.app.inject({ url: '/api/library', headers: { cookie: b.cookie } })).json();
    expect(bob.hidden).toEqual([]);
    expect(bob.playlists.map((c: { id: string }) => c.id)).toContain(PL);
  });
});
