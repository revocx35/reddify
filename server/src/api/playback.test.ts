import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { Candidate } from '../library/matcher.js';
import { makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';
import { castToken, verifyCastToken } from './playback.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const TRACK = '0DiWol3AO6WpXZgp0goxAV'; // One More Time (getTrack fixture), 320 s
const AUDIO = Buffer.alloc(300_000, 1);

function fakeSearch(): Promise<Candidate[]> {
  return Promise.resolve([
    { type: 'videos', videoId: 'AAAAAAAAAAA', title: 'One More Time (Live)', artists: ['Daft Punk'], album: '', duration: 600 },
    { type: 'songs', videoId: 'FGBhQbmPwH8', title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', duration: 321 },
  ]);
}

/** Writes the file slowly, like yt-dlp: the stream must serve the first bytes before the last are written. */
function slowFetch(chunks = 6, delay = 40) {
  return async (_v: string, out: string, onMeta: (ext: string, size: number | null) => void) => {
    const file = out.replace('%(ext)s', 'm4a');
    onMeta('m4a', AUDIO.length);
    const step = AUDIO.length / chunks;
    for (let i = 0; i < chunks; i++) {
      await fsp.appendFile(file, AUDIO.subarray(i * step, (i + 1) * step));
      await new Promise((r) => setTimeout(r, delay));
    }
  };
}

describe('playback', () => {
  it('first play streams while downloading, then serves the library file with ranges', async () => {
    t = await makeApp({}, { search: fakeSearch, fetchAudio: slowFetch(), fetchCover: async () => Buffer.from('jpg') });
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const prep = await t.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/prepare`, headers: h });
    expect(['queued', 'downloading', 'ready']).toContain(prep.json().status);
    const first = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie } });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('audio/mp4');
    expect(first.rawPayload.length).toBe(AUDIO.length);
    expect(first.rawPayload.equals(AUDIO)).toBe(true);
    // Now complete: chosen match is the studio song, not the live video.
    await new Promise((r) => setTimeout(r, 50));
    const f = t.ctx.repo.file(TRACK)!;
    expect(f.status).toBe('ready');
    expect(f.source_id).toBe('FGBhQbmPwH8');
    const ranged = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie, range: 'bytes=100-199' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe(`bytes 100-199/${AUDIO.length}`);
    expect(ranged.rawPayload.length).toBe(100);
    const bad = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie, range: 'bytes=999999-' } });
    expect(bad.statusCode).toBe(416);
    expect((await t.app.inject({ url: `/api/cover/${TRACK}`, headers: { cookie: s.cookie } })).statusCode).toBe(200);
  });

  it('a range request into a still-growing file waits for the bytes', async () => {
    t = await makeApp({}, { search: fakeSearch, fetchAudio: slowFetch(10, 60) });
    const s = await setupAdmin(t);
    await t.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/prepare`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
    const r = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie, range: 'bytes=250000-' } });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.length).toBe(AUDIO.length - 250_000);
  });

  it('a downloaded track plays when Spotify is down, for every user, and offline search finds it', async () => {
    t = await makeApp({}, { search: fakeSearch, fetchAudio: slowFetch(2, 1) });
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    await t.app.inject({ url: `/api/stream/${TRACK}`, headers: h });
    await new Promise((r) => setTimeout(r, 30));
    t.spotify.offline = true;
    const again = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: h });
    expect(again.statusCode).toBe(200);
    const search = await t.app.inject({ url: '/api/search?q=one%20more', headers: h });
    expect(search.json().offline).toBe(true);
    expect(search.json().tracks[0].id).toBe(TRACK);
    expect(search.json().tracks[0].cached).toBe(true);
    const home = await t.app.inject({ url: '/api/home', headers: h });
    expect(home.json().offline).toBe(true);
  });

  it('no acceptable match → failed status with a reason, not a wrong song', async () => {
    t = await makeApp({}, {
      search: async () => [{ type: 'videos', videoId: 'BBBBBBBBBBB', title: 'Something else entirely', artists: ['Nobody'], album: '', duration: 100 }],
      fetchAudio: slowFetch(),
    });
    const s = await setupAdmin(t);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    await t.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/prepare`, headers: h });
    await new Promise((r) => setTimeout(r, 50));
    const st = await t.app.inject({ url: `/api/tracks/${TRACK}/status`, headers: h });
    expect(st.json().status).toBe('failed');
    expect(st.json().error).toMatch(/No matching recording/);
  });

  it('cast URLs: signed, expiring, track-bound, served without a session', async () => {
    const key = Buffer.alloc(32, 9);
    const tok = castToken(key, TRACK, 1);
    expect(verifyCastToken(key, tok)).toEqual({ trackId: TRACK, userId: 1 });
    expect(verifyCastToken(Buffer.alloc(32, 8), tok)).toBeNull();
    expect(verifyCastToken(key, tok.replace(TRACK, '1'.repeat(22)))).toBeNull();
    expect(verifyCastToken(key, tok, Date.now() + 13 * 3600_000)).toBeNull();

    t = await makeApp({ publicOrigin: 'https://reddify.example' }, { search: fakeSearch, fetchAudio: slowFetch(2, 1) });
    const s = await setupAdmin(t);
    const c = await t.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/cast`, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });
    expect(c.statusCode).toBe(200);
    const url = new URL(c.json().url as string);
    expect(url.origin).toBe('https://reddify.example');
    const r = await t.app.inject({ url: url.pathname });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(AUDIO.length);
    expect((await t.app.inject({ url: '/cast/' + 'x'.repeat(60) })).statusCode).toBe(404);
  });

  it('a deleted library file is downloaded again instead of 500', async () => {
    t = await makeApp({}, { search: fakeSearch, fetchAudio: slowFetch(2, 1) });
    const s = await setupAdmin(t);
    await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie } });
    await new Promise((r) => setTimeout(r, 30));
    const f = t.ctx.repo.file(TRACK)!;
    fs.rmSync(`${t.ctx.config.libraryDir}/${f.path}`);
    const r = await t.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie: s.cookie } });
    expect(r.statusCode).toBe(200);
  });
});
