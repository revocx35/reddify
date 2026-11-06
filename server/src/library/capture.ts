import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CaptureSelftest, CaptureStatus, Track } from '../../../shared/api.js';

/*
 * Client for the capture container: a Google Chrome (with Widevine) that plays the track in Spotify's own web player
 * and records what comes out of a PulseAudio virtual speaker (capture/). Reddify never touches Widevine: the CDM
 * decrypts, the browser sends PCM to the sink, and the container reads that sink's monitor and encodes it losslessly.
 *
 * The container is a single, shared audio engine (audio is serial by nature), reachable only on the internal backend
 * network with a bearer token derived from CONTROL_SECRET.
 */

/** Bearer token of the capture container (the same derivation on both sides). */
export function captureToken(controlSecret: Buffer): string {
  return crypto.createHmac('sha256', controlSecret).update('rdf/capture/token').digest('hex');
}

export type CaptureState = 'queued' | 'playing' | 'recording' | 'done' | 'failed';

export interface CaptureJobInfo {
  id: string;
  trackId: string;
  state: CaptureState;
  error: string | null;
  /** Bytes of FLAC written so far. */
  bytes: number;
  /** Length of the recording in milliseconds (when known). */
  durationMs: number | null;
}

const CAPTURE_HEADERS = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

export class SpotifyCapture {
  private readonly token: string;

  constructor(
    /** Base URL of the capture container, or null when this deployment has none. */
    readonly url: string | null,
    controlSecret: Buffer,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.token = captureToken(controlSecret);
  }

  get configured(): boolean {
    return this.url !== null;
  }

  private path(suffix: string): string {
    if (!this.url) throw new Error('No Spotify audio engine is configured (CAPTURE_URL).');
    return `${this.url}${suffix}`;
  }

  private async json<T>(method: string, suffix: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const r = await fetch(this.path(suffix), {
      method,
      headers: { ...CAPTURE_HEADERS(this.token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      let message = `The Spotify audio engine answered ${r.status}.`;
      try {
        const j = (await r.json()) as { error?: string };
        if (j.error) message = j.error;
      } catch {
        /* not JSON */
      }
      throw new Error(message);
    }
    return (await r.json()) as T;
  }

  /** Status for the admin panel; never throws. */
  async status(): Promise<CaptureStatus> {
    if (!this.url) {
      return { configured: false, browser: 'stopped', loggedIn: false, account: null, queued: 0, current: null, captured: 0 };
    }
    try {
      const s = await this.json<Omit<CaptureStatus, 'configured'>>('GET', '/v1/status', undefined, 6000);
      return { configured: true, ...s };
    } catch {
      return { configured: true, browser: 'unreachable', loggedIn: false, account: null, queued: 0, current: null, captured: 0 };
    }
  }

  /** Whether the engine can record right now (reachable and logged in to a Spotify account). */
  async usable(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.url) return { ok: false, reason: 'No Spotify audio engine is configured.' };
    const s = await this.status();
    if (s.browser === 'unreachable') return { ok: false, reason: 'The Spotify audio engine is not reachable.' };
    if (!s.loggedIn) return { ok: false, reason: 'The Spotify audio engine is not logged in (Settings → Admin → Spotify audio).' };
    return { ok: true };
  }

  /** Starts (or joins) a track's capture; resolves once the container accepts it. */
  async start(track: Pick<Track, 'id' | 'durationMs'>): Promise<CaptureJobInfo> {
    return this.json<CaptureJobInfo>('POST', '/v1/captures', { trackId: track.id, durationMs: track.durationMs }, 30_000);
  }

  async job(id: string): Promise<CaptureJobInfo> {
    return this.json<CaptureJobInfo>('GET', `/v1/captures/${encodeURIComponent(id)}`, undefined, 10_000);
  }

  async cancel(id: string): Promise<void> {
    await this.json('DELETE', `/v1/captures/${encodeURIComponent(id)}`);
  }

  /**
   * Records one track into `outFile` and returns when the file is complete.
   *
   * The container starts writing as soon as playback begins, so the bytes are streamed here while the song is still
   * being recorded — `onStart` fires on the first byte (the library can serve the growing file from then on).
   */
  async record(track: Pick<Track, 'id' | 'durationMs'>, outFile: string, onStart: () => void): Promise<CaptureJobInfo> {
    if (!/^[A-Za-z0-9]{22}$/.test(track.id)) throw new Error('bad Spotify track id');
    const budgetMs = Math.max(60_000, track.durationMs + 150_000);
    const job = await this.start(track);
    const started = Date.now();
    // Wait for playback to begin (page load + Spotify's own start-up take a few seconds).
    let info = job;
    while (info.state === 'queued' || info.state === 'playing') {
      if (Date.now() - started > 90_000) {
        await this.cancel(info.id).catch(() => undefined);
        throw new Error(info.error ?? 'Spotify did not start playing that track.');
      }
      await sleep(400);
      info = await this.job(info.id);
    }
    if (info.state === 'failed') throw new Error(info.error ?? 'The Spotify capture failed.');

    const res = await fetch(this.path(`/v1/captures/${encodeURIComponent(info.id)}/audio`), {
      headers: CAPTURE_HEADERS(this.token),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (!res.ok || !res.body) {
      await this.cancel(info.id).catch(() => undefined);
      throw new Error(`The Spotify audio engine answered ${res.status} for the recording.`);
    }
    let first = true;
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          if (first) {
            first = false;
            onStart();
          }
          yield chunk;
        }
      },
      fs.createWriteStream(outFile, { mode: 0o600 }),
    );
    // The stream ends when the recording is finished; the job then knows the final verdict.
    const done = await this.job(info.id);
    if (done.state !== 'done') throw new Error(done.error ?? 'The Spotify capture did not finish.');
    const st = await fsp.stat(outFile);
    if (st.size < 10_000) throw new Error('The Spotify recording is empty (did the browser play any audio?).');
    this.log(`captured ${track.id} from Spotify (${Math.round(st.size / 1024)} KiB, ${Math.round((Date.now() - started) / 1000)} s)`);
    return { ...done, bytes: st.size };
  }

  /* ------------------------------------------------------------------ admin */

  async ensure(): Promise<void> {
    await this.json('POST', '/v1/ensure', {}, 90_000);
  }

  async startLogin(): Promise<void> {
    await this.json('POST', '/v1/login', {}, 40_000);
  }

  async importCookie(spDc: string): Promise<void> {
    await this.json('POST', '/v1/cookie', { spDc }, 40_000);
  }

  async logout(): Promise<void> {
    await this.json('POST', '/v1/logout', {}, 40_000);
  }

  async restart(): Promise<void> {
    await this.json('POST', '/v1/restart', {}, 120_000);
  }

  async selftest(): Promise<CaptureSelftest> {
    return this.json<CaptureSelftest>('POST', '/v1/selftest', {}, 180_000);
  }

  async vncPassword(): Promise<string> {
    const r = await this.json<{ password?: unknown }>('GET', '/v1/vnc-password', undefined, 10_000);
    if (typeof r.password !== 'string') throw new Error('VNC is not available');
    return r.password;
  }

  /** Raw byte tunnel to the engine's x11vnc (HTTP Upgrade: rdf-tunnel, the same header the chromium manager uses). */
  openVncTunnel(timeoutMs = 5000): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const u = new URL(this.path('/v1/vnc'));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(
        u,
        { headers: { ...CAPTURE_HEADERS(this.token), connection: 'Upgrade', upgrade: 'rdf-tunnel' }, timeout: timeoutMs },
      );
      req.on('upgrade', (_res, socket, head) => {
        socket.setTimeout(0);
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      req.on('response', (res) => {
        res.resume();
        reject(new Error(`VNC tunnel refused (${res.statusCode})`));
      });
      req.on('timeout', () => req.destroy(new Error('VNC tunnel timed out')));
      req.on('error', reject);
      req.end();
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
