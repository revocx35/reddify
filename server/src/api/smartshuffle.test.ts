import { afterEach, describe, expect, it } from 'vitest';
import type { Track } from '../../../shared/api.js';
import { fixture, makeApp, setupAdmin, type TestApp } from '../testutil/ctx.js';

let t: TestApp;
afterEach(async () => {
  await t?.app.close();
});

const id = (c: string, n: number) => (c + String(n).padStart(3, '0')).padEnd(22, c);
/** A recommender answer (shape of the captured fixture) listing these track ids. */
function recAnswer(ids: string[]): unknown {
  const tpl = (fixture('internalLinkRecommenderTrack') as { data: { seoRecommendedTrack: { items: { data: Record<string, unknown> }[] } } })
    .data.seoRecommendedTrack.items[0]!;
  return {
    data: { seoRecommendedTrack: { items: ids.map((i) => ({ data: { ...tpl.data, id: i, uri: `spotify:track:${i}`, name: `Song ${i}` } })) } },
  };
}

async function signedIn(): Promise<Record<string, string>> {
  const s = await setupAdmin(t);
  return { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' };
}

const LIST = [id('A', 1), id('A', 2), id('A', 3)];

describe('Smart Shuffle', () => {
  it('mixes recommendations of the seeds round-robin, without the playing list or duplicates', async () => {
    t = await makeApp();
    const h = await signedIn();
    // Each seed recommends one track of the list itself, one shared track and two of its own.
    const per: Record<string, string[]> = {
      [LIST[0]!]: [LIST[1]!, id('S', 0), id('B', 1), id('B', 2)],
      [LIST[1]!]: [id('S', 0), LIST[2]!, id('C', 1), id('C', 2)],
      [LIST[2]!]: [LIST[0]!, id('D', 1), id('S', 0), id('D', 2)],
    };
    const real = t.spotify.query.bind(t.spotify);
    t.spotify.query = async (name, vars) => {
      if (name !== 'internalLinkRecommenderTrack') return real(name, vars);
      t.spotify.calls.push({ name, vars });
      return recAnswer(per[String(vars.uri).split(':')[2]!] ?? []);
    };
    const r = await t.app.inject({ method: 'POST', url: '/api/smart-shuffle', headers: h, payload: { trackIds: LIST, count: 50 } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { tracks: Track[]; offline: boolean };
    expect(body.offline).toBe(false);
    const ids = body.tracks.map((x) => x.id);
    expect(ids.sort()).toEqual([id('B', 1), id('B', 2), id('C', 1), id('C', 2), id('D', 1), id('D', 2), id('S', 0)].sort());
    expect(t.spotify.calls.filter((c) => c.name === 'internalLinkRecommenderTrack')).toHaveLength(3);

    const few = await t.app.inject({ method: 'POST', url: '/api/smart-shuffle', headers: h, payload: { trackIds: LIST, count: 2 } });
    expect((few.json() as { tracks: Track[] }).tracks).toHaveLength(2);
  });

  it('falls back to random library tracks (never from the list) when Spotify is down', async () => {
    t = await makeApp();
    const h = await signedIn();
    const lib = [id('L', 1), id('L', 2), LIST[0]!];
    t.ctx.repo.upsertTracks(lib.map((i) => ({ id: i, name: i, artists: [], album: null, durationMs: 1000, explicit: false, playable: true, cover: null })));
    for (const i of lib) t.ctx.repo.fileReady({ trackId: i, path: `/x/${i}`, size: 1, mime: 'audio/mp4', sourceId: 'x', source: 'youtube', score: 1, hasCover: false });
    t.spotify.offline = true;
    const r = await t.app.inject({ method: 'POST', url: '/api/smart-shuffle', headers: h, payload: { trackIds: LIST } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { tracks: Track[]; offline: boolean };
    expect(body.offline).toBe(true);
    expect(body.tracks.map((x) => x.id).sort()).toEqual([id('L', 1), id('L', 2)]);
  });

  it('validates the body and needs a session and the CSRF token', async () => {
    t = await makeApp();
    const h = await signedIn();
    const post = (headers: Record<string, string>, payload: unknown) => t.app.inject({ method: 'POST', url: '/api/smart-shuffle', headers, payload: payload as object });
    expect((await post(h, { trackIds: [] })).statusCode).toBe(400);
    expect((await post(h, { trackIds: ['not-an-id'] })).statusCode).toBe(400);
    expect((await post(h, { trackIds: Array.from({ length: 501 }, (_, i) => id('E', i)) })).statusCode).toBe(400);
    expect((await post(h, { trackIds: LIST, count: 51 })).statusCode).toBe(400);
    const { 'x-csrf-token': _csrf, ...noCsrf } = h;
    expect((await post(noCsrf, { trackIds: LIST })).statusCode).toBe(403);
    expect((await post({ 'content-type': 'application/json' }, { trackIds: LIST })).statusCode).toBe(401);
  });
});
