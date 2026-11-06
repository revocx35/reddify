import type { FastifyInstance, FastifyRequest } from 'fastify';
import type net from 'node:net';
import { z } from 'zod';
import type { SpotifyStatus, VncCredentials } from '../../../shared/api.js';
import { type AppContext, instanceFor } from '../context.js';
import { Errors } from '../errors.js';
import { requireUser } from '../http/server.js';

const MAX_VNC = 4;
const HIGH_WATER = 8 * 1024 * 1024;

/**
 * The user's Spotify browser: status, login (over the live screen = VNC, or by importing an sp_dc cookie), logout,
 * restart. Only the instance's owner — or an admin, e.g. for the shared instance — may manage it.
 */
export function registerSpotifyRoutes(app: FastifyInstance, ctx: AppContext): void {
  function manageable(req: FastifyRequest) {
    const a = requireUser(req);
    const inst = instanceFor(ctx, a.user);
    const canManage = a.user.role === 'admin' || inst === a.user.id;
    return { a, inst, s: ctx.pool.get(inst), canManage };
  }

  function mustManage(req: FastifyRequest) {
    const m = manageable(req);
    if (!m.canManage) throw Errors.forbidden('This Spotify browser is shared; ask an admin to manage it.');
    return m;
  }

  app.get('/api/spotify/status', async (req): Promise<SpotifyStatus> => {
    const { inst, s, canManage } = manageable(req);
    const browser = s.connected ? 'running' : (await s.link.reachable(2000)) ? 'running' : 'stopped';
    const { loggedIn } = await s.loggedIn().catch(() => ({ loggedIn: false }));
    return {
      instance: inst,
      mode: ctx.repo.adminSettings().instanceMode,
      canManage,
      browser,
      loggedIn,
      account: null,
      learned: s.learnedOps(),
    };
  });

  app.post('/api/spotify/connect', async (req) => {
    const { s } = manageable(req);
    await s.ready();
    return { ok: true };
  });

  app.post('/api/spotify/login', async (req) => {
    const { s, a } = mustManage(req);
    await s.startLogin();
    ctx.repo.audit('spotify_login_started', req.ip, a.user.id);
    return { ok: true };
  });

  app.post('/api/spotify/cookie', async (req) => {
    const { s, a } = mustManage(req);
    const { spDc } = z.object({ spDc: z.string().trim().max(1000) }).parse(req.body);
    await s.importCookie(spDc);
    ctx.repo.audit('spotify_cookie_imported', req.ip, a.user.id);
    return { ok: true };
  });

  app.post('/api/spotify/logout', async (req) => {
    const { s, a } = mustManage(req);
    await s.logout();
    ctx.repo.audit('spotify_logout', req.ip, a.user.id);
    return { ok: true };
  });

  app.post('/api/spotify/restart', async (req) => {
    const { s } = mustManage(req);
    await s.restart();
    return { ok: true };
  });

  /* ---------------------------------------------------------------- live screen */
  app.get('/api/vnc/credentials', async (req): Promise<VncCredentials> => {
    const { s } = mustManage(req);
    await s.link.ensure();
    return { password: await s.link.vncPassword().catch(() => { throw Errors.unavailable('The browser is not running yet.'); }) };
  });

  let open = 0;
  app.get('/api/vnc', { websocket: true }, (socket, req) => {
    let m: ReturnType<typeof mustManage>;
    try {
      m = mustManage(req);
    } catch {
      socket.close(4003, 'Not allowed');
      return;
    }
    if (open >= MAX_VNC) {
      socket.close(1013, 'Too many screens open');
      return;
    }
    open++;
    ctx.repo.audit('vnc_opened', req.ip, m.a.user.id);
    let tunnel: net.Socket | null = null;
    let closed = false;
    const sessionHash = m.a.session?.id_hash ?? null;
    const close = (code = 1000, reason = '') => {
      if (closed) return;
      closed = true;
      open--;
      clearInterval(revalidate);
      tunnel?.destroy();
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };
    // The screen closes when the session ends (logout, revoked, expired).
    const revalidate = setInterval(() => {
      if (sessionHash && !ctx.repo.session(sessionHash)) close(4001, 'Session ended');
    }, 30_000);
    socket.on('close', () => close());
    socket.on('error', () => close(1011));
    const early: Buffer[] = [];
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return;
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (tunnel && !tunnel.destroyed) tunnel.write(buf);
      else if (!tunnel && early.length < 64) early.push(buf);
    });
    m.s.link
      .ensure()
      .then(() => m.s.link.openVncTunnel())
      .then((tcp) => {
        if (closed) {
          tcp.destroy();
          return;
        }
        tunnel = tcp;
        tcp.setNoDelay(true);
        for (const b of early.splice(0)) tcp.write(b);
        tcp.on('data', (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          socket.send(chunk, { binary: true });
          if (socket.bufferedAmount > HIGH_WATER) {
            tcp.pause();
            const resume = setInterval(() => {
              if (closed || socket.bufferedAmount < HIGH_WATER / 2) {
                clearInterval(resume);
                tcp.resume();
              }
            }, 50);
          }
        });
        tcp.on('close', () => close(1011, 'VNC server closed the connection'));
        tcp.on('error', () => close(1011, 'VNC server unavailable'));
      })
      .catch(() => close(1011, 'VNC server unavailable'));
  });
}
