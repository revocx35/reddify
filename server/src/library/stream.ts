import type { FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Errors } from '../errors.js';
import type { Job } from './downloader.js';

/** Parses a single-range `Range: bytes=a-b` header. null = no/ignored header, 'bad' = unsatisfiable. */
export function parseRange(h: string | undefined, size: number): { start: number; end: number } | null | 'bad' {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad';
  return { start, end };
}

/** Reads [start, end] of a file that another process is still appending to; waits for missing bytes. */
class GrowingFileReader extends Readable {
  private pos: number;
  private fd: fsp.FileHandle | null = null;
  private busy = false;
  private more = false;

  constructor(
    private readonly file: string,
    start: number,
    private readonly end: number,
    private readonly job: Job,
  ) {
    super({ highWaterMark: 256 * 1024 });
    this.pos = start;
  }

  override _read(size: number): void {
    // One pull loop at a time: Node may call _read again while a read is in flight (that duplicated bytes).
    if (this.busy) {
      this.more = true;
      return;
    }
    this.busy = true;
    void this.pull(size).finally(() => {
      this.busy = false;
      if (this.more && !this.destroyed) {
        this.more = false;
        this._read(size);
      }
    });
  }

  private async pull(size: number): Promise<void> {
    try {
      if (!this.fd) {
        // yt-dlp announced the file name before it created the file: give it a moment.
        for (let i = 0; i < 100 && !this.fd; i++) {
          try {
            this.fd = await fsp.open(this.file, 'r');
          } catch {
            if (this.job.status === 'failed') throw new Error('download failed');
            if (this.job.status === 'done' && this.job.file) this.fd = await fsp.open(this.job.file, 'r');
            else await sleep(100);
          }
        }
        if (!this.fd) throw new Error('file did not appear');
      }
      while (!this.destroyed) {
        const want = Math.min(size, this.end - this.pos + 1);
        if (want <= 0) {
          this.push(null);
          return;
        }
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await this.fd.read(buf, 0, want, this.pos);
        if (bytesRead > 0) {
          this.pos += bytesRead;
          if (!this.push(buf.subarray(0, bytesRead))) return;
          continue;
        }
        if (this.job.status === 'failed') throw new Error('download failed');
        if (this.job.status === 'done') {
          // Complete but shorter than announced: end what we have.
          this.push(null);
          return;
        }
        await new Promise<void>((r) => {
          const done = (): void => {
            clearTimeout(timer);
            this.job.off('end', done);
            r();
          };
          const timer = setTimeout(done, 150);
          this.job.once('end', done);
        });
      }
    } catch (e) {
      this.destroy(e instanceof Error ? e : new Error(String(e)));
    }
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    const fd = this.fd;
    this.fd = null;
    if (fd) fd.close().then(() => cb(err), () => cb(err));
    else cb(err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rangeHeaders(reply: FastifyReply, mime: string, size: number, range: { start: number; end: number } | null): void {
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', mime);
  reply.header('Cache-Control', 'private, max-age=86400');
  if (range) {
    reply.status(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', String(range.end - range.start + 1));
  } else {
    reply.header('Content-Length', String(size));
  }
}

/** A finished library file, with Range support. */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: { path: string; size: number; mime: string }): FastifyReply {
  const range = parseRange(req.headers.range, file.size);
  if (range === 'bad') {
    reply.header('Content-Range', `bytes */${file.size}`);
    return reply.status(416).send();
  }
  rangeHeaders(reply, file.mime, file.size, range);
  if (req.method === 'HEAD') return reply.send();
  return reply.send(fs.createReadStream(file.path, range ? { start: range.start, end: range.end } : {}));
}

/** A file that is still downloading: Range support when the final size is known, else wait for the end. */
export async function sendJob(req: FastifyRequest, reply: FastifyReply, job: Job): Promise<FastifyReply> {
  await job.meta;
  if (job.status === 'failed') throw Errors.unavailable(job.error ?? 'The download failed.');
  if (job.size === null) {
    await job.done;
    if (job.status !== 'done' || !job.file) throw Errors.unavailable(job.error ?? 'The download failed.');
    const st = await fsp.stat(job.file);
    return sendFile(req, reply, { path: job.file, size: st.size, mime: job.mime });
  }
  const size = job.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') {
    reply.header('Content-Range', `bytes */${size}`);
    return reply.status(416).send();
  }
  rangeHeaders(reply, job.mime, size, range);
  if (req.method === 'HEAD') return reply.send();
  const { start, end } = range ?? { start: 0, end: size - 1 };
  // The tmp path is opened before the rename to the library; an open descriptor survives the move.
  return reply.send(new GrowingFileReader(job.file!, start, end, job));
}
