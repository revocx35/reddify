import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { captureToken } from '../library/capture.js';

/*
 * A stand-in for the capture container, for tests: the real SpotifyCapture client talks HTTP to it exactly as it talks
 * to the deployed Chrome service (status, POST /v1/captures, the growing /audio stream), so the protocol, the bearer
 * token and the streaming are all exercised without a browser.
 */

export interface StubCaptureOptions {
  loggedIn?: boolean;
  /** Refuse the capture with this message instead of recording. */
  fail?: string;
  chunks?: number;
  chunkSize?: number;
  delayMs?: number;
  /** Answers with 401 unless the bearer token is the derived one. */
  requireToken?: boolean;
}

export interface StubCapture {
  url: string;
  secret: Buffer;
  requests: { method: string; path: string; authorized: boolean }[];
  close(): Promise<void>;
}

/** Plausible FLAC-ish bytes; only the size matters to the server. */
function payload(opts: StubCaptureOptions): Buffer {
  const chunks = opts.chunks ?? 3;
  const size = opts.chunkSize ?? 20_000;
  const b = Buffer.alloc(chunks * size);
  for (let i = 0; i < b.length; i++) b[i] = (i * 7 + 13) & 0xff;
  b.write('fLaC', 0);
  return b;
}

export async function stubCapture(opts: StubCaptureOptions = {}): Promise<StubCapture> {
  const secret = Buffer.from('s'.repeat(48));
  const token = captureToken(secret);
  const requests: StubCapture['requests'] = [];
  const body = payload(opts);
  let state: 'recording' | 'done' | 'failed' = opts.fail ? 'failed' : 'recording';

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const authorized = req.headers.authorization === `Bearer ${token}`;
    requests.push({ method: req.method ?? '', path: url, authorized });
    const json = (code: number, v: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (opts.requireToken !== false && !authorized) {
      json(401, { error: 'unauthorized' });
      return;
    }
    if (url === '/v1/status') {
      json(200, {
        browser: 'running',
        loggedIn: opts.loggedIn ?? true,
        account: 'Tester',
        queued: 0,
        current: state === 'recording' ? 'track' : null,
        captured: state === 'done' ? 1 : 0,
      });
      return;
    }
    if (url === '/v1/captures' && req.method === 'POST') {
      req.resume();
      if (opts.fail) {
        json(200, { id: 'c1', trackId: 'x', state: 'failed', error: opts.fail, bytes: 0, durationMs: null });
        return;
      }
      json(200, { id: 'c1', trackId: 'x', state: 'recording', error: null, bytes: 0, durationMs: null });
      return;
    }
    if (url === '/v1/captures/c1' && req.method === 'GET') {
      json(200, {
        id: 'c1',
        trackId: 'x',
        state,
        error: state === 'failed' ? (opts.fail ?? null) : null,
        bytes: state === 'done' ? body.length : 0,
        durationMs: state === 'done' ? 1000 : null,
      });
      return;
    }
    if (url === '/v1/captures/c1/audio') {
      // Real-time: the bytes arrive chunk by chunk, like the recording of a playing song.
      const chunks = opts.chunks ?? 3;
      const size = opts.chunkSize ?? 20_000;
      res.writeHead(200, { 'content-type': 'audio/flac' });
      let i = 0;
      const tick = (): void => {
        if (i >= chunks) {
          state = 'done';
          res.end();
          return;
        }
        res.write(body.subarray(i * size, (i + 1) * size));
        i++;
        setTimeout(tick, opts.delayMs ?? 5).unref();
      };
      tick();
      return;
    }
    if (url === '/v1/captures/c1' && req.method === 'DELETE') {
      json(200, { ok: true });
      return;
    }
    json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
