import crypto from 'node:crypto';
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CastResponse, PrepareResponse, Track } from '../../../shared/api.js';
import { safeEqual } from '../auth/sessions.js';
import { type AppContext, instanceFor } from '../context.js';
import { Errors } from '../errors.js';
import { expectedOrigin, requireAdmin, requireUser } from '../http/server.js';
import { sendFile, sendJob } from '../library/stream.js';
import { isOffline } from '../spotify/catalog.js';
import { IdParam } from './catalog.js';

const CAST_TTL_MS = 12 * 3600_000;

/** Cast capability: `<trackId>.<expiry>.<userId>.<hmac>` — lets one Chromecast fetch one track for 12 h, nothing else. */
export function castToken(key: Buffer, trackId: string, userId: number, now = Date.now()): string {
  const exp = Math.floor((now + CAST_TTL_MS) / 1000);
  const sig = crypto.createHmac('sha256', key).update(`cast|${trackId}|${exp}|${userId}`).digest('base64url').slice(0, 32);
  return `${trackId}.${exp}.${userId}.${sig}`;
}

export function verifyCastToken(key: Buffer, token: string, now = Date.now()): { trackId: string; userId: number } | null {
  const m = /^([A-Za-z0-9]{22})\.(\d{9,11})\.(\d{1,9})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const [, trackId, exp, uid, sig] = m;
  const want = crypto.createHmac('sha256', key).update(`cast|${trackId}|${exp}|${uid}`).digest('base64url').slice(0, 32);
  if (!safeEqual(sig!, want)) return null;
  if (Number(exp) * 1000 < now) return null;
  return { trackId: trackId!, userId: Number(uid) };
}

/**
 * Playback: prepare (metadata + start the download), stream (library file, or the bytes of a running download),
 * covers, play counts and casting.
 */
export function registerPlaybackRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function trackFor(userId: number, id: string): Promise<Track> {
    const s = ctx.pool.get(instanceFor(ctx, { id: userId }));
    try {
      return await ctx.catalog.track(s, id);
    } catch (e) {
      // Spotify is down: a track whose metadata we already have can still be served/downloaded.
      const known = ctx.repo.track(id);
      if (known && isOffline(e)) return known;
      throw e;
    }
  }

  function statusOf(id: string): PrepareResponse {
    return { id, ...ctx.downloader.status(id) };
  }

  app.post('/api/tracks/:id/prepare', async (req): Promise<PrepareResponse> => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    if (ctx.downloader.readyFile(id)) return { id, status: 'ready' };
    const track = await trackFor(a.user.id, id);
    ctx.downloader.ensure(track);
    return statusOf(id);
  });

  app.get('/api/tracks/:id/status', async (req): Promise<PrepareResponse> => {
    requireUser(req);
    const { id } = IdParam.parse(req.params);
    return statusOf(id);
  });

  app.post('/api/tracks/:id/played', async (req) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    if (ctx.repo.track(id)) ctx.repo.recordPlay(a.user.id, id);
    return { ok: true };
  });

  async function stream(req: FastifyRequest, reply: FastifyReply, id: string, userId: number): Promise<FastifyReply> {
    const ready = ctx.downloader.readyFile(id);
    if (ready) return sendFile(req, reply, ready);
    const track = await trackFor(userId, id);
    const job = ctx.downloader.ensure(track);
    if (!job) {
      const r = ctx.downloader.readyFile(id);
      if (r) return sendFile(req, reply, r);
      throw Errors.unavailable('The track is not available.');
    }
    return sendJob(req, reply, job);
  }

  app.get('/api/stream/:id', async (req, reply) => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const { download } = z.object({ download: z.literal('1').optional() }).parse(req.query);
    if (download) {
      // "Download file": wait for the complete file, then send it as an attachment named "Artist - Title.ext".
      const track = await trackFor(a.user.id, id);
      const job = ctx.downloader.ensure(track);
      if (job) await job.done;
      const ready = ctx.downloader.readyFile(id);
      if (!ready) throw Errors.unavailable(job?.error ?? 'The track is not available.');
      const ext = ready.path.split('.').pop() ?? 'm4a';
      const name = `${track.artists.map((x) => x.name).join(', ')} - ${track.name}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 150);
      reply.header('Content-Disposition', `attachment; filename="track.${ext}"; filename*=UTF-8''${encodeURIComponent(`${name}.${ext}`)}`);
      return sendFile(req, reply, ready);
    }
    return stream(req, reply, id, a.user.id);
  });

  app.get('/api/cover/:id', async (req, reply) => {
    requireUser(req);
    const { id } = IdParam.parse(req.params);
    const p = ctx.downloader.coverPath(id);
    if (!p) throw Errors.notFound();
    reply.header('Cache-Control', 'private, max-age=604800');
    return reply.type('image/jpeg').send(fs.createReadStream(p));
  });

  /* ------------------------------------------------------------------- casting */
  app.post('/api/tracks/:id/cast', async (req): Promise<CastResponse> => {
    const a = requireUser(req);
    const { id } = IdParam.parse(req.params);
    const track = await trackFor(a.user.id, id);
    const job = ctx.downloader.ensure(track);
    if (job) await job.meta;
    if (job?.status === 'failed') throw Errors.unavailable(job.error ?? 'The download failed.');
    const ready = ctx.downloader.readyFile(id);
    const contentType = ready?.mime ?? job?.mime ?? 'audio/mp4';
    const origin = expectedOrigin(ctx, req);
    return {
      url: `${origin}/cast/${castToken(ctx.config.appKey, id, a.user.id)}`,
      contentType,
      cover: track.cover,
      track: ctx.repo.markCached([track])[0]!,
    };
  });

  // Public on purpose (a Chromecast has no session): the HMAC token is the permission. Kept out of the logs.
  app.get('/cast/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().max(120) }).parse(req.params);
    const v = verifyCastToken(ctx.config.appKey, token);
    if (!v) throw Errors.notFound();
    const user = ctx.repo.userById(v.userId);
    if (!user || user.disabled) throw Errors.notFound();
    reply.header('Access-Control-Allow-Origin', '*'); // the Cast receiver page fetches with CORS
    return stream(req, reply, v.trackId, v.userId);
  });

  /* --------------------------------------------------------------- admin: files */
  app.delete('/api/admin/library/:id', async (req) => {
    requireAdmin(req);
    const { id } = IdParam.parse(req.params);
    await ctx.downloader.remove(id);
    ctx.repo.audit('library_file_removed', req.ip, req.auth!.user.id);
    return { ok: true };
  });
}
