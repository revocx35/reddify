import type {
  AlbumResponse,
  ArtistRef,
  ArtistResponse,
  Card,
  HomeResponse,
  PlaylistResponse,
  SearchResponse,
  Section,
  Track,
  TrackPage,
} from '../../../shared/api.js';

/*
 * Spotify's web player GraphQL ("pathfinder") answers → Reddify's models. Everything here is untrusted input:
 * every field is optional, ids are checked against the base62 shape, strings are capped, and an unexpected shape
 * yields an empty result instead of an exception. The shapes are pinned by the fixtures in src/__fixtures__ (captured
 * from open.spotify.com, 2026-11-06).
 */

type J = Record<string, unknown>;

export const ID_RE = /^[A-Za-z0-9]{22}$/;
const MAX_TEXT = 500;

function obj(v: unknown): J | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function get(o: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = o;
  for (const p of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof p === 'number') cur = Array.isArray(cur) ? cur[p] : undefined;
    else cur = obj(cur)?.[p];
  }
  return cur;
}

/** "spotify:track:<id>" → id (only when the kind matches and the id has the right shape). */
export function uriId(uri: unknown, kind: string): string | null {
  if (typeof uri !== 'string') return null;
  const m = /^spotify:(?:user:[^:]+:)?([a-z]+):([A-Za-z0-9]{22})$/.exec(uri);
  return m && m[1] === kind ? m[2]! : null;
}

function idOf(o: J | null, kind: string): string | null {
  if (!o) return null;
  const fromUri = uriId(o.uri, kind);
  if (fromUri) return fromUri;
  return typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : null;
}

/** Picks an image URL from a `sources` list, preferring the one closest to `want` px. Only Spotify CDN hosts pass. */
export function pickImage(sources: unknown, want = 300): string | null {
  let best: { url: string; d: number } | null = null;
  for (const s of arr(sources)) {
    const url = str(get(s, 'url'), 1000);
    if (!safeImageUrl(url)) continue;
    const w = Number(get(s, 'width')) || 0;
    const d = w ? Math.abs(w - want) : 10_000;
    if (!best || d < best.d) best = { url, d };
  }
  return best?.url ?? null;
}

export function safeImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(scdn\.co|spotifycdn\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** Unwraps `{__typename: '…ResponseWrapper', data}`, `{item: …}`, `{itemV2: …}`, `{track: …}`, `{content: …}`. */
function unwrap(v: unknown): J | null {
  let o = obj(v);
  for (let i = 0; i < 4 && o; i++) {
    const t = str(o.__typename);
    if (t.endsWith('ResponseWrapper') || (!t && o.data)) o = obj(o.data);
    else if (!t && o.item) o = obj(o.item);
    else if (!t && o.itemV2) o = obj(o.itemV2);
    else if (!t && o.track && !o.uri) o = obj(o.track);
    else if (!t && o.content && !o.uri) o = obj(o.content);
    else break;
  }
  return o;
}

function artistsOf(o: J): ArtistRef[] {
  const list = [
    ...arr(get(o, 'artists', 'items')),
    ...arr(get(o, 'firstArtist', 'items')),
    ...arr(get(o, 'otherArtists', 'items')),
  ];
  const out: ArtistRef[] = [];
  for (const a of list) {
    const ao = obj(a);
    const id = idOf(ao, 'artist');
    const name = str(get(ao, 'profile', 'name'));
    if (id && name && !out.some((x) => x.id === id)) out.push({ id, name });
  }
  return out.slice(0, 20);
}

export interface AlbumContext {
  id: string;
  name: string;
  cover: string | null;
}

/** Any Track object (search, album, playlist, recommendation, home) → Track. */
export function parseTrack(v: unknown, ctx?: AlbumContext): Track | null {
  const o = unwrap(v);
  if (!o) return null;
  const tn = str(o.__typename);
  if (tn && tn !== 'Track') return null;
  const id = idOf(o, 'track');
  const name = str(o.name);
  if (!id || !name) return null;
  const albumO = obj(o.albumOfTrack);
  const albumId = idOf(albumO, 'album') ?? ctx?.id ?? null;
  const albumName = str(albumO?.name) || ctx?.name || '';
  const duration = Number(get(o, 'duration', 'totalMilliseconds') ?? get(o, 'trackDuration', 'totalMilliseconds')) || 0;
  return {
    id,
    name,
    artists: artistsOf(o),
    album: albumId ? { id: albumId, name: albumName } : null,
    cover: pickImage(get(albumO, 'coverArt', 'sources')) ?? ctx?.cover ?? null,
    durationMs: Math.max(0, Math.min(duration, 6 * 3600_000)),
    explicit: get(o, 'contentRating', 'label') === 'EXPLICIT',
    playable: get(o, 'playability', 'playable') !== false,
  };
}

function year(o: J | null): string {
  const iso = str(get(o, 'date', 'isoString'));
  if (iso) return iso.slice(0, 4);
  const y = get(o, 'date', 'year');
  return typeof y === 'number' ? String(y) : '';
}

const KIND_TYPENAME: Record<string, string> = { track: 'Track', album: 'Album', artist: 'Artist', playlist: 'Playlist' };

/** Album / Artist / Playlist / Track object → Card (typename from `__typename`, else from the uri). */
export function parseCard(v: unknown): Card | null {
  const o = unwrap(v);
  if (!o) return null;
  const tn = str(o.__typename) || KIND_TYPENAME[/^spotify:(?:user:[^:]+:)?([a-z]+):/.exec(str(o.uri))?.[1] ?? ''] || '';
  if (tn === 'Track') {
    const t = parseTrack(o);
    return t ? { kind: 'track', id: t.id, name: t.name, subtitle: t.artists.map((a) => a.name).join(', '), image: t.cover, track: t } : null;
  }
  if (tn === 'Album' || tn === 'PreRelease') {
    const id = idOf(o, 'album');
    if (!id) return null;
    const artists = artistsOf(o).map((a) => a.name).join(', ');
    const y = year(o);
    return {
      kind: 'album',
      id,
      name: str(o.name),
      subtitle: [y, artists].filter(Boolean).join(' • '),
      image: pickImage(get(o, 'coverArt', 'sources')),
    };
  }
  if (tn === 'Artist') {
    const id = idOf(o, 'artist');
    if (!id) return null;
    return {
      kind: 'artist',
      id,
      name: str(get(o, 'profile', 'name')),
      subtitle: 'Artist',
      image: pickImage(get(o, 'visuals', 'avatarImage', 'sources')),
    };
  }
  if (tn === 'Playlist') {
    const id = idOf(o, 'playlist');
    if (!id) return null;
    const desc = stripHtml(str(o.description));
    const owner = str(get(o, 'ownerV2', 'data', 'name'));
    return {
      kind: 'playlist',
      id,
      name: str(o.name),
      subtitle: desc || (owner ? `By ${owner}` : 'Playlist'),
      image: pickImage(get(o, 'images', 'items', 0, 'sources')),
    };
  }
  return null;
}

function cards(list: unknown): Card[] {
  const out: Card[] = [];
  for (const it of arr(list)) {
    const c = parseCard(it);
    if (c && c.name) out.push(c);
  }
  return out;
}

function tracks(list: unknown, ctx?: AlbumContext): Track[] {
  const out: Track[] = [];
  for (const it of arr(list)) {
    const t = parseTrack(it, ctx);
    if (t && !out.some((x) => x.id === t.id)) out.push(t);
  }
  return out;
}

export function parseHome(json: unknown): Omit<HomeResponse, 'offline'> {
  const home = obj(get(json, 'data', 'home'));
  const sections: Section[] = [];
  for (const s of arr(get(home, 'sectionContainer', 'sections', 'items'))) {
    const title = str(get(s, 'data', 'title', 'transformedLabel')) || str(get(s, 'data', 'title', 'text'));
    const items = cards(arr(get(s, 'sectionItems', 'items')).map((i) => get(i, 'content')));
    if (title && items.length) sections.push({ title, items });
  }
  return { greeting: str(get(home, 'greeting', 'transformedLabel')) || 'Good to see you', sections };
}

export function parseSearch(json: unknown, query: string): Omit<SearchResponse, 'offline'> {
  const s = obj(get(json, 'data', 'searchV2'));
  const top = cards(get(s, 'topResultsV2', 'itemsV2'))[0] ?? cards(get(s, 'topResultsV2', 'featured'))[0] ?? null;
  return {
    query,
    top,
    tracks: tracks(arr(get(s, 'tracksV2', 'items')).map((i) => get(i, 'item') ?? i)),
    artists: cards(get(s, 'artists', 'items')),
    albums: cards(get(s, 'albumsV2', 'items')),
    playlists: cards(get(s, 'playlists', 'items')),
  };
}

export function parseSearchTracks(json: unknown, offset: number): TrackPage {
  const tv = obj(get(json, 'data', 'searchV2', 'tracksV2'));
  return {
    tracks: tracks(arr(tv?.items).map((i) => get(i, 'item') ?? i)),
    total: Number(tv?.totalCount) || 0,
    offset,
  };
}

export function parseAlbum(json: unknown): AlbumResponse | null {
  const a = obj(get(json, 'data', 'albumUnion'));
  const id = idOf(a, 'album');
  if (!a || !id) return null;
  const cover = pickImage(get(a, 'coverArt', 'sources'), 640);
  const ctx = { id, name: str(a.name), cover: pickImage(get(a, 'coverArt', 'sources')) };
  const artists = artistsOf(a);
  const list = tracks(arr(get(a, 'tracksV2', 'items')).map((i) => get(i, 'track') ?? i), ctx);
  // Album tracks carry no album/cover of their own: fill both from the album.
  for (const t of list) {
    t.album = { id, name: ctx.name };
    t.cover = t.cover ?? ctx.cover;
  }
  return {
    album: {
      id,
      name: ctx.name,
      cover,
      artists,
      year: year(a),
      type: str(a.type).toLowerCase() || 'album',
      label: str(a.label),
    },
    tracks: list,
  };
}

export function parseArtist(json: unknown): ArtistResponse | null {
  const a = obj(get(json, 'data', 'artistUnion'));
  const id = idOf(a, 'artist');
  if (!a || !id) return null;
  const d = obj(a.discography);
  const listeners = Number(get(a, 'stats', 'monthlyListeners'));
  return {
    artist: {
      id,
      name: str(get(a, 'profile', 'name')),
      image: pickImage(get(a, 'visuals', 'avatarImage', 'sources'), 640),
      header: pickImage(get(a, 'headerImage', 'data', 'sources'), 2000),
      monthlyListeners: Number.isFinite(listeners) ? listeners : null,
    },
    topTracks: tracks(arr(get(d, 'topTracks', 'items')).map((i) => get(i, 'track') ?? i)).slice(0, 10),
    albums: albumsOrPopular(d),
    singles: cards(arr(get(d, 'singles', 'items')).map((i) => get(i, 'releases', 'items', 0) ?? i)),
    related: cards(get(a, 'relatedContent', 'relatedArtists', 'items')),
  };
}

function albumsOrPopular(d: J | null): Card[] {
  const albums = cards(arr(get(d, 'albums', 'items')).map((i) => get(i, 'releases', 'items', 0) ?? i));
  return albums.length ? albums : cards(get(d, 'popularReleasesAlbums', 'items'));
}

export function parsePlaylist(json: unknown, offset: number): PlaylistResponse | null {
  const p = obj(get(json, 'data', 'playlistV2'));
  const id = idOf(p, 'playlist');
  if (!p || !id) return null;
  return {
    playlist: {
      id,
      name: str(p.name),
      description: stripHtml(str(p.description)),
      image: pickImage(get(p, 'images', 'items', 0, 'sources'), 640),
      owner: str(get(p, 'ownerV2', 'data', 'name')),
    },
    tracks: tracks(arr(get(p, 'content', 'items')).map((i) => get(i, 'itemV2') ?? i)),
    total: Number(get(p, 'content', 'totalCount')) || 0,
    offset,
  };
}

export function parseRecommendations(json: unknown): Track[] {
  const d = obj(get(json, 'data'));
  const list = arr(get(d, 'seoRecommendedTrack', 'items'));
  return tracks(list.map((i) => get(i, 'data') ?? i));
}

export function parseTrackUnion(json: unknown): Track | null {
  return parseTrack(get(json, 'data', 'trackUnion'));
}

/** The logged-in account's playlists from `libraryV3` (shape varies; anything that parses as a playlist card). */
export function parseLibrary(json: unknown): Card[] {
  const items = arr(get(json, 'data', 'me', 'libraryV3', 'items'));
  return cards(items.map((i) => get(i, 'item') ?? i)).filter((c) => c.kind === 'playlist' || c.kind === 'album' || c.kind === 'artist');
}

/** Liked songs from `fetchLibraryTracks`. */
export function parseLibraryTracks(json: unknown, offset: number): TrackPage {
  const t = obj(get(json, 'data', 'me', 'library', 'tracks'));
  return { tracks: tracks(arr(t?.items).map((i) => get(i, 'track') ?? i)), total: Number(t?.totalCount) || 0, offset };
}

/** pathfinder signals a stale persisted-query hash with this error. */
export function isPersistedQueryNotFound(json: unknown): boolean {
  return arr(get(json, 'errors')).some((e) => /PersistedQueryNotFound/i.test(str(get(e, 'message'))));
}
