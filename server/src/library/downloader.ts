import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileStatus, Track } from '../../../shared/api.js';
import type { Repo } from '../db/repo.js';
import { safeImageUrl } from '../spotify/parse.js';
import { type Candidate, pickBest, searchQuery } from './matcher.js';

/*
 * Turns a Spotify track into a file in the shared library, once: match on YouTube Music (py/ytm.py + matcher.ts),
 * then yt-dlp writes the audio straight into the library's tmp/ directory while the stream route already serves the
 * bytes that are there (progressive playback on the first play). When yt-dlp is done the file moves to
 * library/<xx>/<trackId>.<ext> and every later play, by any user and any Spotify instance, is served from disk.
 */

const EXT_MIME: Record<string, string> = {
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

const RETRY_FAILED_AFTER_MS = 10 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 6 * 60_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export type SearchFn = (query: string) => Promise<Candidate[]>;

export class Job extends EventEmitter {
  status: 'queued' | 'matching' | 'downloading' | 'done' | 'failed' = 'queued';
  /** Where the bytes are being written (tmp) or are (final). */
  file: string | null = null;
  mime = 'audio/mp4';
  /** Exact final size when yt-dlp knows it up front; null otherwise (then the stream waits for the end). */
  size: number | null = null;
  error: string | null = null;
  /** Resolves once the format is known (file, mime, size) or the job failed. */
  readonly meta: Promise<void>;
  /** Resolves when the file is complete (or the job failed). */
  readonly done: Promise<void>;
  private resolveMeta!: () => void;
  private resolveDone!: () => void;

  constructor(readonly track: Track) {
    super();
    this.setMaxListeners(50);
    this.meta = new Promise((r) => (this.resolveMeta = r));
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  metaKnown(): void {
    this.resolveMeta();
  }

  finish(status: 'done' | 'failed', error?: string): void {
    this.status = status;
    this.error = error ?? null;
    this.resolveMeta();
    this.resolveDone();
    this.emit('end');
  }
}

export interface DownloaderOptions {
  libraryDir: string;
  ytdlp: string;
  python: string;
  helperDir: string;
  maxParallel: number;
  log?: (msg: string) => void;
  /** Tests replace the YouTube Music search and the yt-dlp run. */
  search?: SearchFn;
  fetchAudio?: (videoId: string, outTemplate: string, onMeta: (ext: string, size: number | null) => void) => Promise<void>;
  fetchCover?: (url: string) => Promise<Buffer | null>;
}

export class Downloader {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly tmpDir: string;
  private readonly coverDir: string;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly repo: Repo,
    private readonly opts: DownloaderOptions,
  ) {
    this.tmpDir = path.join(opts.libraryDir, 'tmp');
    this.coverDir = path.join(opts.libraryDir, 'covers');
    this.log = opts.log ?? (() => undefined);
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.coverDir, { recursive: true, mode: 0o700 });
    // Leftovers of an interrupted run are never complete: drop them.
    for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { force: true });
  }

  /** The library file for a track if it is complete and still on disk. */
  readyFile(trackId: string): { path: string; size: number; mime: string } | null {
    const f = this.repo.file(trackId);
    if (f?.status !== 'ready' || !f.path) return null;
    const abs = path.join(this.opts.libraryDir, f.path);
    try {
      const st = fs.statSync(abs);
      return { path: abs, size: st.size, mime: f.mime ?? 'audio/mp4' };
    } catch {
      // Deleted behind our back: forget it so the next play downloads it again.
      this.repo.removeFile(trackId);
      return null;
    }
  }

  status(trackId: string): { status: FileStatus; error?: string } {
    if (this.readyFile(trackId)) return { status: 'ready' };
    const j = this.jobs.get(trackId);
    if (j) return j.status === 'failed' ? { status: 'failed', error: j.error ?? undefined } : { status: j.status === 'queued' ? 'queued' : 'downloading' };
    const f = this.repo.file(trackId);
    if (f?.status === 'failed' && Date.now() - f.created_at < RETRY_FAILED_AFTER_MS) return { status: 'failed', error: f.error ?? undefined };
    return { status: 'none' };
  }

  activeCount(): number {
    return [...this.jobs.values()].filter((j) => j.status !== 'done' && j.status !== 'failed').length;
  }

  coverPath(trackId: string): string | null {
    const p = path.join(this.coverDir, `${trackId}.jpg`);
    return fs.existsSync(p) ? p : null;
  }

  /** Starts (or joins) the download of a track. Returns null when the file is already in the library. */
  ensure(track: Track): Job | null {
    if (this.readyFile(track.id)) return null;
    const existing = this.jobs.get(track.id);
    if (existing && existing.status !== 'failed') return existing;
    const f = this.repo.file(track.id);
    if (existing?.status === 'failed' || (f?.status === 'failed' && Date.now() - f.created_at < RETRY_FAILED_AFTER_MS)) {
      if (existing) return existing;
      const j = new Job(track);
      j.finish('failed', f?.error ?? 'Download failed');
      return j;
    }
    const job = new Job(track);
    this.jobs.set(track.id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  /** Removes a track's audio from the library (admin). */
  async remove(trackId: string): Promise<void> {
    const f = this.repo.file(trackId);
    if (f?.path) await fsp.rm(path.join(this.opts.libraryDir, f.path), { force: true });
    await fsp.rm(path.join(this.coverDir, `${trackId}.jpg`), { force: true });
    this.repo.removeFile(trackId);
  }

  private pump(): void {
    while (this.running < this.opts.maxParallel && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      void this.run(job)
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          this.repo.fileFailed(job.track.id, msg);
          job.finish('failed', msg);
          this.log(`download ${job.track.id} failed: ${msg}`);
        })
        .finally(() => {
          this.running--;
          // Failed jobs stay visible for a while so clients see the error, then a new attempt is allowed.
          setTimeout(() => {
            if (this.jobs.get(job.track.id) === job) this.jobs.delete(job.track.id);
          }, job.status === 'failed' ? RETRY_FAILED_AFTER_MS : 0).unref();
          this.pump();
        });
    }
  }

  private async run(job: Job): Promise<void> {
    const t = job.track;
    const t0 = Date.now();
    job.status = 'matching';
    const search = this.opts.search ?? ((q: string) => this.ytmSearch(q));
    let candidates = await search(searchQuery(t));
    let best = pickBest(t, candidates);
    if (!best) {
      // Second try with every artist and the bare title (helps with "feat." tracks and transliterated names).
      candidates = await search(`${t.name} ${t.artists.map((a) => a.name).join(' ')}`.slice(0, 250));
      best = pickBest(t, candidates);
    }
    if (!best) throw new Error('No matching recording found on YouTube Music.');
    const tMatch = Date.now() - t0;
    let tMeta = 0;
    job.status = 'downloading';
    const outTemplate = path.join(this.tmpDir, `${t.id}.%(ext)s`);
    const fetchAudio = this.opts.fetchAudio ?? ((v, o, m) => this.ytdlpFetch(v, o, m));
    await fetchAudio(best.candidate.videoId, outTemplate, (ext, size) => {
      job.file = path.join(this.tmpDir, `${t.id}.${ext}`);
      job.mime = EXT_MIME[ext] ?? 'application/octet-stream';
      job.size = size && size > 0 && size < MAX_FILE_BYTES ? size : null;
      tMeta = Date.now() - t0;
      job.metaKnown();
    });
    if (!job.file) throw new Error('yt-dlp did not report the file.');
    const st = await fsp.stat(job.file);
    if (st.size < 10_000) throw new Error('The downloaded file is too small.');
    if (job.size !== null && st.size !== job.size) job.size = st.size;
    const ext = path.extname(job.file).slice(1);
    const rel = path.join(t.id.slice(0, 2).toLowerCase(), `${t.id}.${ext}`);
    const abs = path.join(this.opts.libraryDir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
    await fsp.rename(job.file, abs);
    job.file = abs;
    const hasCover = await this.saveCover(t).catch(() => false);
    this.repo.fileReady({ trackId: t.id, path: rel, size: st.size, mime: job.mime, sourceId: best.candidate.videoId, score: best.score, hasCover });
    this.log(`downloaded ${t.id} (${Math.round(st.size / 1024)} KiB, score ${best.score}; matched ${tMatch} ms, streaming from ${tMeta} ms, done ${Date.now() - t0} ms)`);
    job.finish('done');
  }

  private async saveCover(t: Track): Promise<boolean> {
    if (!t.cover || !safeImageUrl(t.cover)) return false;
    const buf = this.opts.fetchCover
      ? await this.opts.fetchCover(t.cover)
      : await fetch(t.cover, { signal: AbortSignal.timeout(15_000), redirect: 'error' }).then(async (r) =>
          r.ok && (r.headers.get('content-type') ?? '').startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : null,
        );
    if (!buf || buf.length > 5 * 1024 * 1024) return false;
    await fsp.writeFile(path.join(this.coverDir, `${t.id}.jpg`), buf, { mode: 0o600 });
    return true;
  }

  /* ------------------------------------------------------------- external tools */

  private ytmSearch(query: string): Promise<Candidate[]> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.opts.python, ['-I', path.join(this.opts.helperDir, 'ytm.py'), query], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d: Buffer) => {
        if (out.length < 2_000_000) out += d.toString();
      });
      p.stderr.on('data', (d: Buffer) => {
        if (err.length < 4000) err += d.toString();
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error(`YouTube Music search failed (${code}): ${err.trim().slice(-200)}`));
        try {
          const list = JSON.parse(out) as Candidate[];
          resolve(Array.isArray(list) ? list.filter((c) => /^[A-Za-z0-9_-]{11}$/.test(c.videoId)) : []);
        } catch {
          reject(new Error('YouTube Music search returned garbage.'));
        }
      });
    });
  }

  private ytdlpFetch(videoId: string, outTemplate: string, onMeta: (ext: string, size: number | null) => void): Promise<void> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return Promise.reject(new Error('bad video id'));
    const args = [
      '--ignore-config', '--no-playlist', '--no-part', '--no-mtime', '--no-progress', '--fixup', 'never',
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec=opus]/bestaudio',
      '--max-filesize', String(MAX_FILE_BYTES),
      '--http-chunk-size', '1M',
      '--cache-dir', path.join(this.opts.libraryDir, '..', 'cache', 'yt-dlp'),
      '--no-simulate', '--print', 'before_dl:REDDIFY %(ext)s %(filesize)s',
      '-o', outTemplate,
      '--', `https://music.youtube.com/watch?v=${videoId}`,
    ];
    return new Promise((resolve, reject) => {
      const p = spawn(this.opts.ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: DOWNLOAD_TIMEOUT_MS });
      let buf = '';
      let err = '';
      let sawMeta = false;
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const m = /^REDDIFY ([a-z0-9]{2,5}) (\d+|NA)$/.exec(line);
          if (m && !sawMeta && EXT_MIME[m[1]!]) {
            sawMeta = true;
            onMeta(m[1]!, m[2] === 'NA' ? null : Number(m[2]));
          }
        }
        if (buf.length > 100_000) buf = '';
      });
      p.stderr.on('data', (d: Buffer) => {
        err = (err + d.toString()).slice(-2000);
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0 && sawMeta) resolve();
        else reject(new Error(`yt-dlp failed (${code}): ${err.trim().split('\n').pop()?.slice(0, 200) ?? ''}`));
      });
    });
  }
}
