import { afterEach, describe, expect, it } from 'vitest';
import type { Candidate } from './matcher.js';
import { SpotifyCapture } from './capture.js';
import { isAudioSource, sourceOrder } from './sources.js';
import { makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';
import { stubCapture, type StubCapture } from '../testutil/capture-stub.js';

const TRACK = '0DiWol3AO6WpXZgp0goxAV'; // One More Time (getTrack fixture), 320 s
const AUDIO = Buffer.alloc(40_000, 3);

let t: TestApp | undefined;
let stub: StubCapture | undefined;
afterEach(async () => {
  await t?.app.close();
  await stub?.close();
  t = undefined;
  stub = undefined;
});

function ytSearch(hits = true): () => Promise<Candidate[]> {
  return async () =>
    hits
      ? [{ type: 'songs', videoId: 'FGBhQbmPwH8', title: 'One More Time', artists: ['Daft Punk'], album: 'Discovery', duration: 321 }]
      : [];
}

async function ytAudio(_v: string, out: string, onMeta: (ext: string, size: number | null) => void): Promise<void> {
  const file = out.replace('%(ext)s', 'm4a');
  onMeta('m4a', AUDIO.length);
  await (await import('node:fs/promises')).writeFile(file, AUDIO);
}

/** A test app whose downloader uses the stub capture container, with `audio_source` already set. */
async function appWith(source: string, opts: { ytHits?: boolean; capture?: Parameters<typeof stubCapture>[0] } = {}): Promise<{
  app: TestApp;
  capture: StubCapture;
  cookie: string;
  csrf: string;
}> {
  stub = await stubCapture({ chunks: 3, chunkSize: 20_000, delayMs: 5, ...opts.capture });
  t = await makeApp(
    {},
    {
      search: ytSearch(opts.ytHits ?? true),
      fetchAudio: ytAudio,
      fetchCover: async () => Buffer.from('jpg'),
      capture: new SpotifyCapture(stub.url, stub.secret),
    },
  );
  t.ctx.repo.setSetting('audio_source', source);
  const s = await setupAdmin(t);
  return { app: t, capture: stub, ...s };
}

describe('audio sources', () => {
  it('orders the connections the admin chose, and only the preferred ones fall back', () => {
    expect(sourceOrder('youtube')).toEqual(['youtube']);
    expect(sourceOrder('spotify')).toEqual(['spotify']);
    expect(sourceOrder('youtube-preferred')).toEqual(['youtube', 'spotify']);
    expect(sourceOrder('spotify-preferred')).toEqual(['spotify', 'youtube']);
    expect(isAudioSource('spotify')).toBe(true);
    expect(isAudioSource('both')).toBe(false);
    expect(isAudioSource(null)).toBe(false);
  });

  it('Spotify only: records the track through the capture container into the library', async () => {
    const { app, capture, cookie } = await appWith('spotify');
    const r = await app.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/flac');
    // The recording is served while it is written: no fixed length, chunked by the server.
    expect(r.headers['content-length']).toBeUndefined();
    expect(r.rawPayload.length).toBe(60_000);
    await new Promise((res) => setTimeout(res, 30));
    const f = app.ctx.repo.file(TRACK)!;
    expect(f.status).toBe('ready');
    expect(f.source).toBe('spotify');
    expect(f.path).toBe(`${TRACK.slice(0, 2).toLowerCase()}/${TRACK}.flac`);
    expect(f.mime).toBe('audio/flac');
    // Every call carried the derived bearer token.
    expect(capture.requests.length).toBeGreaterThan(0);
    expect(capture.requests.every((x) => x.authorized)).toBe(true);
    const st = app.ctx.repo.storage();
    expect(st.bySource).toEqual({ youtube: 0, spotify: 1 });
  });

  it('Spotify only: a failed capture is a failed track, not a silent fallback to YouTube', async () => {
    const { app, cookie, csrf } = await appWith('spotify', { capture: { fail: 'Spotify played an ad instead of the track.' } });
    const prep = await app.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/prepare`, headers: { cookie, 'x-csrf-token': csrf } });
    expect(prep.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    const st = await app.app.inject({ url: `/api/tracks/${TRACK}/status`, headers: { cookie } });
    expect(st.json().status).toBe('failed');
    expect(st.json().error).toMatch(/ad instead of the track/);
    // A failed row is remembered (so clients see the reason), and nothing was put in the library.
    expect(app.ctx.repo.file(TRACK)?.status).toBe('failed');
    expect(app.ctx.repo.storage().tracks).toBe(0);
  });

  it('Spotify preferred: falls back to YouTube Music when the engine cannot deliver', async () => {
    const { app, cookie } = await appWith('spotify-preferred', { capture: { fail: 'The Spotify audio engine is not logged in.' } });
    const r = await app.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mp4');
    expect(r.rawPayload.length).toBe(AUDIO.length);
    await new Promise((res) => setTimeout(res, 30));
    expect(app.ctx.repo.file(TRACK)!.source).toBe('youtube');
  });

  it('YouTube preferred: falls back to Spotify when YouTube Music has no match', async () => {
    const { app, cookie } = await appWith('youtube-preferred', { ytHits: false });
    const r = await app.app.inject({ url: `/api/stream/${TRACK}`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/flac');
    await new Promise((res) => setTimeout(res, 30));
    expect(app.ctx.repo.file(TRACK)!.source).toBe('spotify');
  });

  it('reports both connections when neither can deliver', async () => {
    const { app, cookie, csrf } = await appWith('youtube-preferred', { ytHits: false, capture: { fail: 'Not logged in.' } });
    const prep = await app.app.inject({ method: 'POST', url: `/api/tracks/${TRACK}/prepare`, headers: { cookie, 'x-csrf-token': csrf } });
    expect(prep.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 60));
    const st = await app.app.inject({ url: `/api/tracks/${TRACK}/status`, headers: { cookie } });
    expect(st.json().status).toBe('failed');
    expect(st.json().error).toMatch(/YouTube Music: No matching recording/);
    expect(st.json().error).toMatch(/Spotify: Not logged in/);
  });
});
