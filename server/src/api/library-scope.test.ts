import fsp from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Track } from '../../../shared/api.js';
import type { Candidate } from '../library/matcher.js';
import { cookieOf, makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

/** One More Time (the getTrack fixture), queued by the admin through the API. */
const A = '0DiWol3AO6WpXZgp0goxAV';
/** A second track, added by the non-admin user. */
const B = 'B'.repeat(22);
const AUDIO = Buffer.alloc(60_000, 1);

const BOB_SONG: Track = {
  id: B,
  name: 'Bob Song',
  artists: [{ id: 'AR'.repeat(11), name: 'Bob' }],
  album: null,
  cover: null,
  durationMs: 200_000,
  explicit: false,
  playable: true,
  cached: false,
};

/** YouTube Music, faked: the candidate for whichever track the downloader is matching. */
function fakeSearch(q: string): Promise<Candidate[]> {
  const candidate: Candidate = q.includes('Bob')
    ? { type: 'songs', videoId: 'BBBBBBBBBBB', title: 'Bob Song', artists: ['Bob'], album: '', duration: 200 }
    : { type: 'songs', videoId: 'FGBhQbmPwH8', title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', duration: 321 };
  return Promise.resolve([candidate]);
}

function fakeAudio() {
  return async (_v: string, out: string, onMeta: (ext: string, size: number | null) => void) => {
    const file = out.replace('%(ext)s', 'm4a');
    onMeta('m4a', AUDIO.length);
    await fsp.writeFile(file, AUDIO);
  };
}

async function addUser(admin: { cookie: string; csrf: string }, username: string): Promise<{ cookie: string; csrf: string; id: number }> {
  const created = await t.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    payload: { username, role: 'user' },
  });
  expect(created.statusCode).toBe(200);
  const login = await t.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: created.json().temporaryPassword },
  });
  expect(login.statusCode).toBe(200);
  return { ...cookieOf(login), id: t.ctx.repo.userByName(username)!.id };
}

describe('the shared library is listed per user', () => {
  it('a non-admin only sees the songs they added themselves; admins see everything', async () => {
    t = await makeApp({}, { search: fakeSearch, fetchAudio: fakeAudio() });
    const admin = await setupAdmin(t);
    const h = { cookie: admin.cookie, 'x-csrf-token': admin.csrf };

    // The admin queues One More Time: its download and its library entry are the admin's.
    expect((await t.app.inject({ method: 'POST', url: `/api/tracks/${A}/prepare`, headers: h })).statusCode).toBe(200);
    for (let i = 0; i < 60 && t.ctx.repo.file(A)?.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(t.ctx.repo.file(A)!.status).toBe('ready');

    // Bob adds a song of his own.
    const bob = await addUser(admin, 'bob');
    const b = { cookie: bob.cookie, 'x-csrf-token': bob.csrf };
    t.ctx.repo.upsertTracks([BOB_SONG]);
    t.ctx.repo.claimLibrary(bob.id, B);
    await t.ctx.downloader.ensure(BOB_SONG)!.done;

    const downloads = async (who: { cookie: string }) =>
      (await t.app.inject({ url: '/api/library/downloads', headers: { cookie: who.cookie } })).json() as {
        tracks: Track[];
        total: number;
      };
    const library = async (who: { cookie: string }) =>
      (await t.app.inject({ url: '/api/library', headers: { cookie: who.cookie } })).json() as { downloaded: number };
    const cachedOf = async (who: { cookie: string }, id: string) =>
      (await t.app.inject({ url: `/api/track/${id}`, headers: { cookie: who.cookie } })).json().cached as boolean;

    // Bob sees only his own song; the admin sees the whole shared library.
    expect((await downloads(bob)).tracks.map((x) => x.id)).toEqual([B]);
    expect((await downloads(bob)).total).toBe(1);
    expect((await library(bob)).downloaded).toBe(1);
    expect((await downloads(admin)).tracks.map((x) => x.id).sort()).toEqual([A, B].sort());
    expect((await library(admin)).downloaded).toBe(2);
    // The admin's file is not in Bob's list, and "in your library (plays offline)" is honest about it.
    expect(await cachedOf(bob, A)).toBe(false);
    expect(await cachedOf(bob, B)).toBe(true);
    expect(await cachedOf(admin, A)).toBe(true);

    // Offline, search and the home shelf read Bob's own list only.
    t.spotify.offline = true;
    const search = async (who: { cookie: string }, q: string) =>
      (await t.app.inject({ url: `/api/search?q=${encodeURIComponent(q)}`, headers: { cookie: who.cookie } })).json() as {
        tracks: Track[];
      };
    expect((await search(bob, 'one more')).tracks).toEqual([]);
    expect((await search(bob, 'bob song')).tracks.map((x) => x.id)).toEqual([B]);
    expect((await search(admin, 'one more')).tracks.map((x) => x.id)).toEqual([A]);
    const home = (await t.app.inject({ url: '/api/home', headers: { cookie: bob.cookie } })).json() as {
      offline: boolean;
      sections: { title: string; items: { id: string }[] }[];
    };
    expect(home.offline).toBe(true);
    const shelf = home.sections.find((s) => s.title === 'In your library');
    expect(shelf?.items.map((x) => x.id)).toEqual([B]);
    t.spotify.offline = false;

    // Bob playing the shared file adds it to HIS list (his own action reveals nothing about the admin).
    expect((await t.app.inject({ url: `/api/stream/${A}`, headers: { cookie: bob.cookie } })).statusCode).toBe(200);
    expect((await downloads(bob)).tracks.map((x) => x.id).sort()).toEqual([A, B].sort());
    expect(await cachedOf(bob, A)).toBe(true);

    // Smart Shuffle's offline fallback reads Bob's own list too.
    t.spotify.offline = true;
    const smart = await t.app.inject({
      method: 'POST',
      url: '/api/smart-shuffle',
      headers: b,
      payload: { trackIds: ['D'.repeat(22)], count: 5 },
    });
    expect(smart.json().offline).toBe(true);
    expect((smart.json().tracks as Track[]).map((x) => x.id).sort()).toEqual([A, B].sort());

    // A file Bob never played stays invisible to him and visible to the admin.
    t.ctx.repo.upsertTracks([{ ...BOB_SONG, id: 'C'.repeat(22), name: 'Orphan' }]);
    t.ctx.repo.fileReady({ trackId: 'C'.repeat(22), path: '/x/orphan', size: 1, mime: 'audio/mp4', sourceId: 'x', source: 'youtube', score: 1, hasCover: false });
    expect((await downloads(bob)).tracks.map((x) => x.id).sort()).toEqual([A, B].sort());
    expect((await downloads(admin)).tracks.map((x) => x.id)).toContain('C'.repeat(22));
  });
});
