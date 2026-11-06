import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureConfig } from './config.js';
import type { Engine } from './engine.js';
import { createServer } from './server.js';

const cfg: CaptureConfig = {
  host: '127.0.0.1',
  port: 0,
  controlSecret: Buffer.from('s'.repeat(48)),
  chromeBin: '/bin/false',
  chromeProfile: '/tmp/none',
  workDir: '/tmp/none',
  display: 99,
  width: 1280,
  height: 800,
  timeZone: 'UTC',
  pulseServer: 'unix:/tmp/none',
  sinkName: 'reddify',
  parec: 'false',
  ffmpeg: 'false',
  ffprobe: 'false',
  rate: 44100,
  channels: 2,
  maxQueue: 2,
  idleStopMinutes: 0,
};

let servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function start(): Promise<string> {
  const engine = {
    status: async () => ({ browser: 'stopped', loggedIn: false, account: null, queued: 0, current: null, captured: 3 }),
    enqueue: (trackId: string) => ({ id: 'j1', trackId, state: 'queued', error: null, bytes: 0, frames: 0 }),
    job: () => undefined,
    ensure: async () => undefined,
  } as unknown as Engine;
  const server = createServer({ cfg, engine, log: () => undefined });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const token = crypto.createHmac('sha256', cfg.controlSecret).update('rdf/capture/token').digest('hex');

describe('engine API', () => {
  it('needs the derived bearer token on every route but the health check', async () => {
    const base = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/status`)).status).toBe(401);
    expect((await fetch(`${base}/v1/status`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ browser: 'stopped', captured: 3 });
  });

  it('accepts a capture only with a track id and a duration', async () => {
    const base = await start();
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const bad = await fetch(`${base}/v1/captures`, { method: 'POST', headers: h, body: JSON.stringify({ trackId: 'x' }) });
    expect(bad.status).toBe(400);
    const good = await fetch(`${base}/v1/captures`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ trackId: '0DiWol3AO6WpXZgp0goxAV', durationMs: 320000 }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ id: 'j1', state: 'queued' });
  });

  it('does not serve the selftest page without a nonce', async () => {
    const base = await start();
    expect((await fetch(`${base}/selftest/${'a'.repeat(20)}/`)).status).toBe(404);
  });
});
