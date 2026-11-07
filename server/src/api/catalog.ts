import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LibraryResponse, SmartShuffleResponse, Track, TrackPage } from '../../../shared/api.js';
import { type AppContext, instanceFor } from '../context.js';
import { AppError } from '../errors.js';
import { requireUser } from '../http/server.js';
import { isOffline, sample } from '../spotify/catalog.js';
import { ID_RE } from '../spotify/parse.js';

export const IdParam = z.object({ id: z.string().regex(ID_RE) });
const HiddenParam = z.object({ kind: z.enum(['playlist', 'album', 'artist']), id: z.string().regex(ID_RE) });
const Q = z.string().trim().min(1).max(200);
const SmartShuffleBody = z.object({
  trackIds: z.array(z.string().regex(ID_RE)).min(1).max(500),
  count: z.number().int().min(1).max(50).default(20),
});
const Offset = z.coerce.number().int().min(0).max(10_000).default(0);

/** Spotify's catalogue (through the caller's Spotify instance) and the user's own library lists. */
export function registerCatalogRoutes(app: FastifyInstance, ctx: AppContext): void {
  const session = (userId: number) => {
    const inst = instanceFor(ctx, { id: userId });
    return { inst, s: ctx.pool.get(inst) };
  };

  app.get('/api/home', async (req) => {
    const a = requireUser(req);
    const { inst, s } = session(a.user.id);
    return ctx.catalog.home(s, inst, a.user.id);
  });

  app.get('/api/search', async (req) => {
    const a = requireUser(req);
    const { q } = z.object({ q: Q }).parse(req.query);
    const { inst, s } = session(a.user.id);
    return ctx.catalog.search(s, inst, q);
  });

  app.get('/api/search/tracks', async (req) => {
    const a = requireUser(req);
    const { q, offset } = z.object({ q: Q, offset: Offset }).parse(req.query);
    const { inst, s } = session(a.user.id);
    return ctx.catalog.searchTracks(s, inst, q, offset);
  });

  app.get('/api/album/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return ctx.catalog.album(session(a.user.id).s, id);
  });

  app.get('/api/artist/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return ctx.catalog.artist(session(a.user.id).s, id);
  });

  app.get('/api/playlist/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const { offset } = z.object({ offset: Offset }).parse(req.query);
    const { inst, s } = session(a.user.id);
    return ctx.catalog.playlist(s, inst, id, offset);
  });

  app.get('/api/track/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const t = await ctx.catalog.track(session(a.user.id).s, id);
    return ctx.repo.markCached([t])[0];
  });

  /** "Up next" when the queue runs out: Spotify's recommendations, or other library tracks when offline. */
  app.get('/api/track/:id/recommendations', async (req): Promise<Track[]> => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    try {
      return await ctx.catalog.recommendations(session(a.user.id).s, id);
    } catch (e) {
      if (!isOffline(e)) throw e;
      return ctx.repo
        .cachedTracks({ limit: 50, offset: 0 })
        .tracks.filter((t) => t.id !== id)
        .sort(() => Math.random() - 0.5)
        .slice(0, 20);
    }
  });

  /** Smart Shuffle: recommendations to mix into the shuffled queue (POST: the list of the playing tracks is long). */
  app.post('/api/smart-shuffle', async (req): Promise<SmartShuffleResponse> => {
    const a = requireUser(req);
    const { trackIds, count } = SmartShuffleBody.parse(req.body ?? {});
    try {
      return { tracks: await ctx.catalog.smartShuffle(session(a.user.id).s, trackIds, count), offline: false };
    } catch (e) {
      if (!isOffline(e)) throw e;
      const skip = new Set(trackIds);
      const lib = ctx.repo.cachedTracks({ limit: 200, offset: 0 }).tracks.filter((t) => !skip.has(t.id));
      return { tracks: sample(lib, count), offline: true };
    }
  });

  app.get('/api/library', async (req): Promise<LibraryResponse> => {
    const a = requireUser(req);
    const { inst, s } = session(a.user.id);
    let playlists: LibraryResponse['playlists'] = [];
    const st = await s.loggedIn().catch(() => ({ loggedIn: false }));
    if (st.loggedIn) playlists = await ctx.catalog.libraryPlaylists(s, inst).catch(() => []);
    const hidden = ctx.repo.hiddenLibrary(a.user.id);
    const gone = new Set(hidden.map((c) => `${c.kind}:${c.id}`));
    playlists = playlists.filter((c) => !gone.has(`${c.kind}:${c.id}`));
    return { liked: ctx.repo.likedIds(a.user.id).length, downloaded: ctx.repo.storage().tracks, playlists, hidden, mine: ctx.repo.playlists(a.user.id) };
  });

  // Remove a Spotify playlist/album/artist from Your Library in Reddify only. Nothing is sent to Spotify. The card is
  // taken from the account's library (never from the client), so only items really in the library can be hidden.
  app.put('/api/library/hidden/:kind/:id', async (req) => {
    const a = requireUser(req);
    const { kind, id } = HiddenParam.parse(req.params);
    const { inst, s } = session(a.user.id);
    const items = await ctx.catalog.libraryPlaylists(s, inst);
    const card = items.find((c) => c.kind === kind && c.id === id);
    if (!card) throw new AppError(404, 'not_found', 'That item is not in your Spotify library.');
    ctx.repo.hideLibraryItem(a.user.id, card);
    return { ok: true };
  });

  app.delete('/api/library/hidden/:kind/:id', async (req) => {
    const a = requireUser(req);
    const { kind, id } = HiddenParam.parse(req.params);
    if (!ctx.repo.unhideLibraryItem(a.user.id, kind, id)) throw new AppError(404, 'not_found', 'Not removed.');
    return { ok: true };
  });

  app.get('/api/library/liked', async (req): Promise<Track[]> => ctx.repo.likedTracks(requireUser(req).user.id));

  app.get('/api/library/liked/ids', async (req): Promise<string[]> => ctx.repo.likedIds(requireUser(req).user.id));

  app.put('/api/library/liked/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    await ctx.catalog.track(session(a.user.id).s, id);
    ctx.repo.like(a.user.id, id, true);
    return { ok: true };
  });

  app.delete('/api/library/liked/:id', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    ctx.repo.like(a.user.id, id, false);
    return { ok: true };
  });

  app.get('/api/library/spotify-liked', async (req): Promise<TrackPage> => {
    const a = requireUser(req);
    const { offset } = z.object({ offset: Offset }).parse(req.query);
    const { inst, s } = session(a.user.id);
    return ctx.catalog.spotifyLiked(s, inst, offset);
  });

  app.get('/api/library/downloads', async (req): Promise<TrackPage> => {
    requireUser(req);
    const { q, offset } = z.object({ q: z.string().trim().max(200).optional(), offset: Offset }).parse(req.query);
    const r = ctx.repo.cachedTracks({ q: q || undefined, limit: 100, offset });
    return { tracks: r.tracks, total: r.total, offset };
  });

  app.get('/api/library/recent', async (req): Promise<Track[]> => ctx.repo.recentTracks(requireUser(req).user.id, 50));
}
