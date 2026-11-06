import type { Track } from '../../../shared/api.js';

/** One YouTube Music search result (py/ytm.py). */
export interface Candidate {
  type: 'songs' | 'videos';
  videoId: string;
  title: string;
  artists: string[];
  album: string;
  duration: number | null;
}

export interface Match {
  candidate: Candidate;
  score: number;
}

/** Versions that are a different recording than the studio track unless the Spotify title says so too. */
const VARIANT_WORDS = [
  'live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'sped', 'slowed', 'reverb', 'nightcore', '8d',
  'lyrics', 'lyric', 'edit', 'extended', 'mix', 'version', 'demo', 'reprise', 'piano', 'tribute', 'bass', 'boosted',
];

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Title without decorations Spotify and YouTube add differently: "(feat. X)", "- Remastered 2011", "[Official Video]". */
export function coreTitle(s: string): string {
  return normalize(
    s
      .replace(/\((feat|ft|with)\.?[^)]*\)/gi, ' ')
      .replace(/\[(feat|ft|with)\.?[^\]]*\]/gi, ' ')
      .replace(/\s-\s.*(remaster|version|edit|mono|stereo|mix|live|from).*$/i, ' ')
      .replace(/\((official|lyric|lyrics|audio|video|music video|visualizer|hd|hq|4k)[^)]*\)/gi, ' ')
      .replace(/\[(official|lyric|lyrics|audio|video|music video|visualizer|hd|hq|4k)[^\]]*\]/gi, ' '),
  );
}

function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter(Boolean));
}

/** Share of the Spotify title's words found in the candidate's title (0..1). */
function titleScore(spotify: string, yt: string): number {
  const a = tokens(coreTitle(spotify));
  const b = tokens(coreTitle(yt));
  if (!a.size) return 0;
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  const recall = hit / a.size;
  // Penalise long candidate titles that only contain ours ("X (Live at Wembley 1986) - Full Concert").
  const extra = Math.max(0, b.size - a.size);
  return Math.max(0, recall - Math.min(0.3, extra * 0.05));
}

function artistScore(track: Track, c: Candidate): number {
  const names = track.artists.map((a) => normalize(a.name)).filter(Boolean);
  if (!names.length) return 0.5;
  const hay = normalize([...c.artists, c.title].join(' '));
  const ytArtists = c.artists.map(normalize);
  if (ytArtists.some((y) => y === names[0])) return 1;
  if (names.some((n) => hay.includes(n))) return 0.85;
  // Transliterations/spelling: compare the first artist's words.
  const first = tokens(names[0]!);
  const h = tokens(hay);
  let hit = 0;
  for (const w of first) if (h.has(w)) hit++;
  return first.size ? (hit / first.size) * 0.7 : 0;
}

function durationScore(track: Track, c: Candidate): number {
  if (!track.durationMs || c.duration === null) return 0.4;
  const d = Math.abs(c.duration - track.durationMs / 1000);
  if (d <= 2) return 1;
  if (d >= 25) return 0;
  return 1 - (d - 2) / 23;
}

function variantPenalty(track: Track, c: Candidate): number {
  const ours = tokens(normalize(track.name));
  const theirs = tokens(normalize(c.title));
  let p = 0;
  for (const w of VARIANT_WORDS) if (theirs.has(w) && !ours.has(w)) p += w === 'lyrics' || w === 'lyric' ? 0.05 : 0.3;
  return Math.min(p, 0.6);
}

export function scoreCandidate(track: Track, c: Candidate): number {
  const s =
    0.42 * titleScore(track.name, c.title) +
    0.28 * artistScore(track, c) +
    0.3 * durationScore(track, c) +
    (c.type === 'songs' ? 0.06 : 0) -
    variantPenalty(track, c);
  return Math.round(Math.max(0, Math.min(1, s)) * 1000) / 1000;
}

export const MIN_SCORE = 0.62;

/** The best acceptable candidate, or null. A known Spotify duration must be within 15 s. */
export function pickBest(track: Track, candidates: Candidate[]): Match | null {
  let best: Match | null = null;
  for (const c of candidates) {
    if (track.durationMs && c.duration !== null && Math.abs(c.duration - track.durationMs / 1000) > 15) continue;
    // Same artist and length is not enough: the title itself must largely match.
    if (titleScore(track.name, c.title) < 0.5) continue;
    const score = scoreCandidate(track, c);
    if (score >= MIN_SCORE && (!best || score > best.score)) best = { candidate: c, score };
  }
  return best;
}

export function searchQuery(track: Track): string {
  const artist = track.artists[0]?.name ?? '';
  return `${artist} ${track.name}`.trim().slice(0, 200);
}
