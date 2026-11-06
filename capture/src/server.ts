import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import type { CaptureStatus } from '../../shared/api.js';
import type { CaptureConfig } from './config.js';
import type { Engine, Job } from './engine.js';

/*
 * The engine's HTTP API, on the app's internal network only and behind a bearer token derived from CONTROL_SECRET
 * (server/src/library/capture.ts sends it on every call). The audio route streams a recording as it is written, so the
 * app can serve the first play of a song within seconds instead of after the whole song.
 */

const MAX_BODY = 8 * 1024;
const SELFTEST_TTL_MS = 3 * 60_000;

export interface ServerDeps {
  cfg: CaptureConfig;
  engine: Engine;
  log: (msg: string) => void;
}

/** The bearer token the app derives from the same secret (server/src/library/capture.ts). */
function token(cfg: CaptureConfig): string {
  return crypto.createHmac('sha256', cfg.controlSecret).update('rdf/capture/token').digest('hex');
}

function authorized(req: http.IncomingMessage, expected: string): boolean {
  const h = req.headers.authorization;
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return false;
  const got = Buffer.from(h.slice(7).trim(), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const view = (j: Job): Record<string, unknown> => ({
  id: j.id,
  trackId: j.trackId,
  state: j.state,
  error: j.error,
  bytes: j.bytes,
  durationMs: j.state === 'done' ? Math.round((j.frames / 44100) * 1000) : null,
});

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > MAX_BODY) throw new Error('body too large');
  }
  if (!data) return {};
  const parsed: unknown = JSON.parse(data);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
  return parsed as Record<string, unknown>;
}

export function createServer(deps: ServerDeps): http.Server {
  const { cfg, engine, log } = deps;
  const expected = token(cfg);
  /** Selftest pages: a one-off nonce per run, so the tone page needs no cookie and no token. */
  const selftests = new Map<string, number>();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'failed';
      log(`request ${req.method} ${req.url} failed: ${msg}`);
      if (!res.headersSent) json(res, 500, { error: msg });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return json(res, 200, { ok: true });

    // The selftest page and its tone: reachable without a token, but only through a nonce minted by POST /v1/selftest.
    const self = /^\/selftest\/([A-Za-z0-9_-]{16,64})\/(tone\.wav)?$/.exec(p);
    if (self) {
      const expires = selftests.get(self[1]!);
      if (!expires || expires < Date.now()) return json(res, 404, { error: 'not found' });
      if (self[2]) {
        const wav = await fsp.readFile(`${cfg.workDir}/selftest.wav`).catch(() => null);
        if (!wav) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
        return void res.end(wav);
      }
      const html = `<!doctype html><meta charset="utf-8"><title>Reddify capture test</title>
<body style="background:#111;color:#eee;font:14px system-ui;padding:24px">
<p>Recording the engine's own speaker…</p>
<audio id="a" src="tone.wav" preload="auto"></audio>
<script>
  // Deliberate delay: the recorder must drop the silence before the tone starts.
  setTimeout(function () {
    var a = document.getElementById('a');
    a.volume = 1;
    a.play().catch(function (e) { document.body.textContent = 'play failed: ' + e; });
  }, 800);
</script>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(html);
    }

    if (!authorized(req, expected)) {
      return json(res, 401, { error: 'unauthorized' });
    }

    if (p === '/v1/status' && req.method === 'GET') {
      const status: Omit<CaptureStatus, 'configured'> = await engine.status();
      return json(res, 200, status);
    }

    if (p === '/v1/captures' && req.method === 'POST') {
      const b = await body(req);
      const trackId = b.trackId;
      const durationMs = b.durationMs;
      if (typeof trackId !== 'string' || typeof durationMs !== 'number') return json(res, 400, { error: 'bad request' });
      return json(res, 200, view(engine.enqueue(trackId, durationMs)));
    }

    const one = /^\/v1\/captures\/([A-Za-z0-9-]{8,64})(\/audio)?$/.exec(p);
    if (one) {
      const job = engine.job(one[1]!);
      if (!job) return json(res, 404, { error: 'no such capture' });
      if (one[2] && req.method === 'GET') return streamAudio(req, res, job);
      if (req.method === 'GET') return json(res, 200, view(job));
      if (req.method === 'DELETE') {
        engine.cancel(job.id);
        return json(res, 200, { ok: true });
      }
    }

    if (p === '/v1/ensure' && req.method === 'POST') {
      await engine.ensure();
      return json(res, 200, { ok: true });
    }
    if (p === '/v1/restart' && req.method === 'POST') {
      await engine.restart();
      return json(res, 200, { ok: true });
    }
    if (p === '/v1/login' && req.method === 'POST') {
      await engine.startLogin();
      return json(res, 200, { ok: true });
    }
    if (p === '/v1/cookie' && req.method === 'POST') {
      const b = await body(req);
      if (typeof b.spDc !== 'string') return json(res, 400, { error: 'bad request' });
      await engine.importCookie(b.spDc);
      return json(res, 200, { ok: true });
    }
    if (p === '/v1/logout' && req.method === 'POST') {
      await engine.logout();
      return json(res, 200, { ok: true });
    }
    if (p === '/v1/selftest' && req.method === 'POST') {
      const nonce = crypto.randomBytes(16).toString('base64url');
      selftests.set(nonce, Date.now() + SELFTEST_TTL_MS);
      try {
        const result = await engine.selftest(`http://127.0.0.1:${cfg.port}/selftest/${nonce}/`);
        return json(res, 200, result);
      } finally {
        selftests.delete(nonce);
      }
    }
    if (p === '/v1/vnc-password' && req.method === 'GET') {
      const pw = engine.vncPassword();
      if (!pw) return json(res, 503, { error: 'the browser is not running' });
      return json(res, 200, { password: pw });
    }
    return json(res, 404, { error: 'not found' });
  }

  /** Streams the FLAC as it is written; ends when the recording does. */
  async function streamAudio(req: http.IncomingMessage, res: http.ServerResponse, job: Job): Promise<void> {
    const deadline = Date.now() + 120_000;
    let fh: fsp.FileHandle | null = null;
    while (!fh) {
      if (job.state === 'failed') return json(res, 409, { error: job.error ?? 'the capture failed' });
      if (job.state === 'done' || Date.now() > deadline) break;
      fh = await fsp.open(job.file, 'r').catch(() => null);
      if (!fh) await new Promise((r) => setTimeout(r, 100));
    }
    if (!fh) return json(res, 409, { error: 'no recording was written' });
    res.writeHead(200, { 'content-type': 'audio/flac', 'cache-control': 'no-store' });
    const buf = Buffer.allocUnsafe(64 * 1024);
    let pos = 0;
    try {
      while (!res.destroyed) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead > 0) {
          pos += bytesRead;
          if (!res.write(Buffer.from(buf.subarray(0, bytesRead)))) {
            await new Promise<void>((r) => res.once('drain', r));
          }
          continue;
        }
        if (job.state === 'done' || job.state === 'failed') break;
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      await fh.close().catch(() => undefined);
      res.end();
    }
    req.resume();
  }

  /* ------------------------------------------------------------------- VNC */
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const p = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (p !== '/v1/vnc') {
      socket.destroy();
      return;
    }
    if (!authorized(req, expected)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    if (req.headers.upgrade !== 'rdf-tunnel') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const up = net.connect(5900, '127.0.0.1');
    up.on('connect', () => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: rdf-tunnel\r\n\r\n');
      if (head.length) up.write(head);
      socket.pipe(up);
      up.pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });

  return server;
}
