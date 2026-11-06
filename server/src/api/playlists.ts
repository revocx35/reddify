import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AddTracksResponse, MyPlaylist, MyPlaylistResponse } from '../../../shared/api.js';
import { type AppContext, instanceFor } from '../context.js';
import { Repo } from '../db/repo.js';
import { Errors } from '../errors.js';
import { requireUser } from '../http/server.js';
import { ID_RE } from '../spotify/parse.js';
import { IdParam } from './catalog.js';

const PlaylistId = z.object({ id: z.coerce.number().int().min(1).max(2 ** 31) });
const PlaylistTrack = z.object({ id: z.coerce.number().int().min(1).max(2 ** 31), trackId: z.string().regex(ID_RE) });
// Control characters out, whitespace collapsed; names are shown everywhere, descriptions on the playlist page.
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
const Name = z.string().max(200).transform(clean).pipe(z.string().min(1, 'Give the playlist a name.').max(100));
const Description = z.string().max(600).transform(clean).pipe(z.string().max(300));
const TrackIds = z.array(z.string().regex(ID_RE)).max(1000);
/** Tracks Reddify has never seen are looked up on Spotify one by one; cap that per request. */
const MAX_LOOKUPS = 25;

/**
 * The user's own playlists. Stored in Reddify's DB (not on Spotify), private to their owner: every route checks
 * ownership and answers 404 for someone else's playlist, so ids cannot be probed.
 */
export function registerPlaylistRoutes(app: FastifyInstance, ctx: AppContext): void {
  function own(userId: number, id: number): MyPlaylist {
    const p = ctx.repo.playlist(userId, id);
    if (!p) throw Errors.notFound('Playlist not found.');
    return p;
  }

  /** Makes sure every id is in the `tracks` table (metadata is needed to show and play it offline). */
  async function known(userId: number, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const missing = unique.filter((id) => !ctx.repo.track(id));
    if (missing.length > MAX_LOOKUPS) throw Errors.badRequest('Some of these songs are unknown to Reddify. Open them once, then try again.');
    if (missing.length) {
      const s = ctx.pool.get(instanceFor(ctx, { id: userId }));
      for (const id of missing) await ctx.catalog.track(s, id);
    }
    return unique;
  }

  app.get('/api/playlists', async (req): Promise<MyPlaylist[]> => ctx.repo.playlists(requireUser(req).user.id));

  app.post('/api/playlists', async (req): Promise<MyPlaylistResponse> => {
    const a = requireUser(req);
    const b = z.object({ name: Name.optional(), description: Description.optional(), tracks: TrackIds.optional() }).parse(req.body ?? {});
    if (ctx.repo.countPlaylists(a.user.id) >= Repo.MAX_PLAYLISTS) throw Errors.conflict(`You already have ${Repo.MAX_PLAYLISTS} playlists.`);
    const ids = b.tracks?.length ? await known(a.user.id, b.tracks) : [];
    const id = ctx.repo.createPlaylist(a.user.id, b.name ?? ctx.repo.nextPlaylistName(a.user.id), b.description ?? '');
    if (ids.length) ctx.repo.addToPlaylist(id, ids);
    return { playlist: own(a.user.id, id), tracks: ctx.repo.playlistTracks(id) };
  });

  app.get('/api/playlists/:id', async (req): Promise<MyPlaylistResponse> => {
    const a = requireUser(req);
    const { id } = PlaylistId.parse(req.params);
    return { playlist: own(a.user.id, id), tracks: ctx.repo.playlistTracks(id) };
  });

  app.patch('/api/playlists/:id', async (req): Promise<MyPlaylist> => {
    const a = requireUser(req);
    const { id } = PlaylistId.parse(req.params);
    const b = z.object({ name: Name.optional(), description: Description.optional() }).parse(req.body ?? {});
    own(a.user.id, id);
    ctx.repo.updatePlaylist(id, b);
    return own(a.user.id, id);
  });

  app.delete('/api/playlists/:id', async (req) => {
    const a = requireUser(req);
    const { id } = PlaylistId.parse(req.params);
    own(a.user.id, id);
    ctx.repo.deletePlaylist(id);
    return { ok: true };
  });

  app.post('/api/playlists/:id/tracks', async (req): Promise<AddTracksResponse> => {
    const a = requireUser(req);
    const { id } = PlaylistId.parse(req.params);
    const { ids } = z.object({ ids: TrackIds.min(1) }).parse(req.body ?? {});
    const p = own(a.user.id, id);
    if (p.count >= Repo.MAX_PLAYLIST_TRACKS) throw Errors.conflict(`A playlist can hold ${Repo.MAX_PLAYLIST_TRACKS} songs.`);
    const added = ctx.repo.addToPlaylist(id, await known(a.user.id, ids));
    return { added, playlist: own(a.user.id, id) };
  });

  app.delete('/api/playlists/:id/tracks/:trackId', async (req): Promise<MyPlaylist> => {
    const a = requireUser(req);
    const { id, trackId } = PlaylistTrack.parse(req.params);
    own(a.user.id, id);
    if (!ctx.repo.removeFromPlaylist(id, trackId)) throw Errors.notFound('That song is not in the playlist.');
    return own(a.user.id, id);
  });

  /** Reorder: move one track to a new 0-based position. */
  app.put('/api/playlists/:id/tracks/:trackId/position', async (req): Promise<MyPlaylist> => {
    const a = requireUser(req);
    const { id, trackId } = PlaylistTrack.parse(req.params);
    const { to } = z.object({ to: z.number().int().min(0).max(Repo.MAX_PLAYLIST_TRACKS) }).parse(req.body ?? {});
    own(a.user.id, id);
    if (!ctx.repo.movePlaylistTrack(id, trackId, to)) throw Errors.notFound('That song is not in the playlist.');
    return own(a.user.id, id);
  });

  /** Ids of the caller's playlists that contain the track ("Add to playlist" menu). */
  app.get('/api/tracks/:id/playlists', async (req): Promise<number[]> => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    return ctx.repo.playlistsWith(a.user.id, id);
  });
}
