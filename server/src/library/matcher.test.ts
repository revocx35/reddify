import { describe, expect, it } from 'vitest';
import type { Track } from '../../../shared/api.js';
import { type Candidate, coreTitle, pickBest, scoreCandidate } from './matcher.js';
import { parseRange } from './stream.js';

const track = (name: string, artist: string, sec: number): Track => ({
  id: 'x'.repeat(22),
  name,
  artists: [{ id: 'a'.repeat(22), name: artist }],
  album: null,
  cover: null,
  durationMs: sec * 1000,
  explicit: false,
  playable: true,
});
const cand = (title: string, artist: string, dur: number | null, type: Candidate['type'] = 'songs'): Candidate => ({
  type,
  videoId: 'v'.repeat(11),
  title,
  artists: [artist],
  album: '',
  duration: dur,
});

describe('matcher', () => {
  it('normalises decorations', () => {
    expect(coreTitle('Get Lucky (feat. Pharrell Williams) - Radio Edit')).toBe('get lucky');
    expect(coreTitle('Bohemian Rhapsody - Remastered 2011')).toBe('bohemian rhapsody');
    expect(coreTitle('Adımı Kalbine Yaz [Official Video]')).toBe('adimi kalbine yaz');
  });

  it('prefers the studio song over live/remix versions and wrong durations', () => {
    const t = track('Adımı Kalbine Yaz', 'Tarkan', 312);
    const best = pickBest(t, [
      cand('Adımı Kalbine Yaz (Ozinga Club Mix)', 'Tarkan', 262),
      cand('Adımı Kalbine Yaz (Live)', 'Tarkan', 315, 'videos'),
      cand('Adımı Kalbine Yaz', 'Tarkan', 313),
    ]);
    expect(best?.candidate.duration).toBe(313);
  });

  it('accepts a music video when it is the only good match', () => {
    const t = track('One More Time', 'Daft Punk', 320);
    expect(pickBest(t, [cand('Daft Punk - One More Time (Official Video)', 'Daft Punk', 322, 'videos')])).not.toBeNull();
  });

  it('refuses unrelated songs and far-off durations', () => {
    const t = track('One More Time', 'Daft Punk', 320);
    expect(pickBest(t, [cand('Around the World', 'Daft Punk', 320)])).toBeNull();
    expect(pickBest(t, [cand('One More Time', 'Daft Punk', 600)])).toBeNull();
    expect(scoreCandidate(t, cand('One More Time (Karaoke Version)', 'Sing King', 320))).toBeLessThan(0.62);
  });
});

describe('range parsing', () => {
  it('handles the common forms', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=10-1000', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('bad');
    expect(parseRange('bytes=5-1', 100)).toBe('bad');
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});
