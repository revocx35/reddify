import type {
  AlbumResponse,
  ArtistResponse,
  Card,
  HomeResponse,
  PlaylistResponse,
  SearchResponse,
  Section,
  Track,
  TrackPage,
} from '../../../shared/api.js';
import type { Repo } from '../db/repo.js';
import { AppError, Errors } from '../errors.js';
import {
  parseAlbum,
  parseArtist,
  parseHome,
  parseLibrary,
  parseLibraryTracks,
  parsePlaylist,
  parseRecommendations,
  parseSearch,
  parseSearchTracks,
  parseTrackUnion,
} from './parse.js';

/** What the catalog needs from a Spotify session (SpotifySession implements it; tests pass a fake). */
export interface Querier {
  query(name: string, vars: Record<string, unknown>): Promise<unknown>;
}

class TtlCache {
  private readonly map = new Map<string, { at: number; value: unknown }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 500,
  ) {}
  get<T>(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.value as T;
  }
  set(key: string, value: unknown): void {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { at: Date.now(), value });
  }
}

/** Errors that mean "Spotify (or the browser) is not available", as opposed to a bad request. */
export function isOffline(e: unknown): boolean {
  return e instanceof AppError ? e.status === 502 || e.status === 503 : true;
}

/**
 * Spotify's catalogue as Reddify serves it: pathfinder operations through a session, parsed, cached briefly and with
 * every track remembered in the library DB (so a played track keeps its metadata when Spotify is gone).
 */
export class Catalog {
  private readonly cache = new TtlCache(10 * 60_000);

  constructor(
    private readonly repo: Repo,
    private readonly timeZone: string,
  ) {}

  private remember<T extends Track>(tracks: T[]): T[] {
    this.repo.upsertTracks(tracks.filter((t) => t.durationMs > 0 || !this.repo.track(t.id)));
    return this.repo.markCached(tracks);
  }

  private rememberCards(cards: Card[]): Card[] {
    const ts = cards.flatMap((c) => (c.track ? [c.track] : []));
    this.remember(ts);
    return cards;
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get<T>(key);
    if (hit !== undefined) return hit;
    const v = await fn();
    this.cache.set(key, v);
    return v;
  }

  /* ------------------------------------------------------------------------ home */

  async home(s: Querier, instance: number, userId: number): Promise<HomeResponse> {
    try {
      const h = await this.cached(`home:${instance}`, async () =>
        parseHome(await s.query('home', { timeZone: this.timeZone, sectionItemsLimit: 12 })),
      );
      for (const sec of h.sections) this.rememberCards(sec.items);
      const recent = this.repo.recentTracks(userId, 12);
      const sections: Section[] = recent.length ? [{ title: 'Recently played', items: recent.map(trackCard) }, ...h.sections] : h.sections;
      return { greeting: h.greeting, sections, offline: false };
    } catch (e) {
      if (!isOffline(e)) throw e;
      return this.offlineHome(userId);
    }
  }

  offlineHome(userId: number): HomeResponse {
    const sections: Section[] = [];
    const recent = this.repo.recentTracks(userId, 20).filter((t) => t.cached);
    if (recent.length) sections.push({ title: 'Recently played', items: recent.map(trackCard) });
    const liked = this.repo.likedTracks(userId).filter((t) => t.cached);
    if (liked.length) sections.push({ title: 'Liked songs', items: liked.slice(0, 20).map(trackCard) });
    const lib = this.repo.cachedTracks({ limit: 30, offset: 0 }).tracks;
    if (lib.length) sections.push({ title: 'In your library', items: lib.map(trackCard) });
    return { greeting: 'Offline: playing from the library', sections, offline: true };
  }

  /* ---------------------------------------------------------------------- search */

  async search(s: Querier, instance: number, q: string): Promise<SearchResponse> {
    try {
      const r = await this.cached(`search:${instance}:${q.toLowerCase()}`, async () =>
        parseSearch(await s.query('searchDesktop', { searchTerm: q, offset: 0, limit: 10, numberOfTopResults: 5 }), q),
      );
      this.remember(r.tracks);
      if (r.top) this.rememberCards([r.top]);
      return { ...r, offline: false };
    } catch (e) {
      if (!isOffline(e)) throw e;
      return this.offlineSearch(q);
    }
  }

  offlineSearch(q: string): SearchResponse {
    const { tracks } = this.repo.cachedTracks({ q, limit: 50, offset: 0 });
    return { query: q, top: null, tracks, artists: [], albums: [], playlists: [], offline: true };
  }

  async searchTracks(s: Querier, instance: number, q: string, offset: number): Promise<TrackPage> {
    try {
      const r = await this.cached(`stracks:${instance}:${q.toLowerCase()}:${offset}`, async () =>
        parseSearchTracks(await s.query('searchTracks', { searchTerm: q, offset, limit: 50, numberOfTopResults: 20 }), offset),
      );
      this.remember(r.tracks);
      return r;
    } catch (e) {
      if (!isOffline(e)) throw e;
      const { tracks, total } = this.repo.cachedTracks({ q, limit: 50, offset });
      return { tracks, total, offset };
    }
  }

  /* ----------------------------------------------------------------------- pages */

  async album(s: Querier, id: string): Promise<AlbumResponse> {
    const r = await this.cached(`album:${id}`, async () => {
      const a = parseAlbum(await s.query('getAlbum', { uri: `spotify:album:${id}`, offset: 0, limit: 300 }));
      if (!a) throw Errors.notFound('Album not found.');
      return a;
    });
    this.remember(r.tracks);
    return r;
  }

  async artist(s: Querier, id: string): Promise<ArtistResponse> {
    const r = await this.cached(`artist:${id}`, async () => {
      const a = parseArtist(await s.query('queryArtistOverview', { uri: `spotify:artist:${id}` }));
      if (!a) throw Errors.notFound('Artist not found.');
      return a;
    });
    this.remember(r.topTracks);
    return r;
  }

  async playlist(s: Querier, instance: number, id: string, offset: number): Promise<PlaylistResponse> {
    // Playlists can be personal ("Discover Weekly"): cache per instance.
    const r = await this.cached(`playlist:${instance}:${id}:${offset}`, async () => {
      const p = parsePlaylist(await s.query('fetchPlaylist', { uri: `spotify:playlist:${id}`, offset, limit: 100 }), offset);
      if (!p) throw Errors.notFound('Playlist not found.');
      return p;
    });
    this.remember(r.tracks);
    return r;
  }

  /** Full metadata of one track (cached in the DB; asks Spotify only when unknown or without a duration). */
  async track(s: Querier | null, id: string): Promise<Track> {
    const known = this.repo.track(id);
    if (known && known.durationMs > 0) return known;
    if (!s) throw Errors.unavailable('Spotify is not available to look this track up.');
    const t = parseTrackUnion(await s.query('getTrack', { uri: `spotify:track:${id}` }));
    if (!t) throw Errors.notFound('Track not found.');
    this.repo.upsertTracks([t]);
    return this.repo.track(id)!;
  }

  async recommendations(s: Querier, id: string): Promise<Track[]> {
    const r = await this.cached(`rec:${id}`, async () =>
      parseRecommendations(await s.query('internalLinkRecommenderTrack', { uri: `spotify:track:${id}`, limit: 20 })),
    );
    return this.remember(r);
  }

  /**
   * Smart Shuffle: Spotify's recommendations for a few tracks of the playing list, mixed round-robin so every seed
   * contributes, without any track of the list itself. Spotify's own Smart Shuffle context only exists once a
   * Spotify client has played the list with it (the web player's `smartShuffle` query answers `uri: ""` before), and
   * the catalogue browser never plays, so the same per-track recommender autoplay uses is the source.
   * Throws "unavailable" only when every seed failed that way (the route then falls back to the library).
   */
  async smartShuffle(s: Querier, trackIds: string[], count: number, maxSeeds = 5): Promise<Track[]> {
    const exclude = new Set(trackIds);
    const seeds = sample([...exclude], maxSeeds);
    const results = await Promise.allSettled(seeds.map((id) => this.recommendations(s, id)));
    const lists = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (!lists.length) {
      const err = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
      throw err ?? Errors.unavailable('Spotify gave no recommendations.');
    }
    const out: Track[] = [];
    const seen = new Set(exclude);
    for (let i = 0; out.length < count && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const t = l[i];
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
        if (out.length >= count) break;
      }
    }
    return out;
  }

  async libraryPlaylists(s: Querier, instance: number): Promise<Card[]> {
    return this.cached(`library:${instance}`, async () => parseLibrary(await s.query('libraryV3', {})));
  }

  async spotifyLiked(s: Querier, instance: number, offset: number): Promise<TrackPage> {
    const r = await this.cached(`liked:${instance}:${offset}`, async () =>
      parseLibraryTracks(await s.query('fetchLibraryTracks', { offset, limit: 50 }), offset),
    );
    this.remember(r.tracks);
    return r;
  }
}

/** Up to `n` distinct random items of `a`. */
export function sample<T>(a: T[], n: number): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b.slice(0, n);
}

export function trackCard(t: Track): Card {
  return { kind: 'track', id: t.id, name: t.name, subtitle: t.artists.map((a) => a.name).join(', '), image: t.cover, track: t };
}
