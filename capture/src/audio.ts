import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

/*
 * The recorder: reads the monitor of a PulseAudio null sink (the "virtual speaker" the engine's Chrome plays into) and
 * encodes the PCM to FLAC, losslessly.
 *
 * Alignment matters more than it sounds. The browser needs a moment between "play" and the first sample reaching the
 * sink, so the recording starts with digital silence; the recorder therefore listens first and only starts the encoder
 * at the first frame above an audibility threshold (with a small pre-roll so nothing of a soft attack is lost), and it
 * stops at the track's own length. What lands on disk is the song, not the song plus a gap.
 */

export interface RecorderOptions {
  file: string;
  parec: string;
  ffmpeg: string;
  pulseServer: string;
  sink: string;
  rate: number;
  channels: number;
  /** Frames to keep (0 = until stop()). */
  maxFrames: number;
  /** Environment for parec/ffmpeg: they need the engine's HOME and PULSE_* (a client without them writes its cookie
   *  into a read-only working directory and never reaches the server). */
  env?: NodeJS.ProcessEnv;
  /** Amplitude above which a frame counts as audio (s16 units). 256 ≈ −42 dBFS. */
  threshold?: number;
  /** Give up when nothing audible arrived for this long. */
  silenceTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** Bytes of one PCM frame (all channels of one sample). */
export function frameBytes(channels: number): number {
  return channels * 2;
}

/** Index of the first frame with a sample above the threshold, or −1 when the buffer is silent. */
export function firstAudibleFrame(buf: Buffer, channels: number, threshold: number): number {
  const fb = frameBytes(channels);
  const frames = Math.floor(buf.length / fb);
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const v = buf.readInt16LE((f * channels + c) * 2);
      if (v > threshold || v < -threshold) return f;
    }
  }
  return -1;
}

/** Peak and RMS of s16 PCM (dBFS), so the engine can prove it recorded something audible. */
export function levels(buf: Buffer): { peakDb: number; rmsDb: number } {
  const n = Math.floor(buf.length / 2);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    sum += v * v;
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  const db = (x: number): number => (x <= 0 ? -100 : Math.max(-100, Math.round(20 * Math.log10(x) * 10) / 10));
  return { peakDb: db(peak), rmsDb: db(rms) };
}

const PRE_ROLL_FRAMES_MS = 25;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;

export class Recorder extends EventEmitter {
  state: 'waiting' | 'recording' | 'done' | 'failed' = 'waiting';
  error: string | null = null;
  /** Frames written to the encoder. */
  frames = 0;
  /** Frames of silence dropped before the first audible one. */
  trimmedFrames = 0;
  levels = { peakDb: -100, rmsDb: -100 };

  private parec: ChildProcess | null = null;
  private ffmpeg: ChildProcess | null = null;
  private pending: Buffer = Buffer.alloc(0);
  private carry: Buffer = Buffer.alloc(0);
  private maxRms = -100;
  private maxPeak = -100;
  private silenceTimer: NodeJS.Timeout | null = null;
  private finishWaiters: (() => void)[] = [];
  private stopping = false;

  constructor(private readonly opts: RecorderOptions) {
    super();
  }

  get frameSize(): number {
    return frameBytes(this.opts.channels);
  }

  /** Starts reading the sink. The encoder starts at the first audible frame. */
  start(): void {
    const { parec, pulseServer, sink, rate, channels } = this.opts;
    const p = spawn(
      parec,
      [
        `--server=${pulseServer}`,
        `--device=${sink}.monitor`,
        '--format=s16le',
        `--rate=${rate}`,
        `--channels=${channels}`,
        '--latency-msec=30',
        '--raw',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: this.opts.env ?? process.env },
    );
    this.parec = p;
    p.stdout?.on('data', (chunk: Buffer) => this.onPcm(chunk));
    let err = '';
    p.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    p.on('error', (e) => this.fail(`could not read the virtual speaker: ${e.message}`));
    p.on('close', (code, signal) => {
      // We stop the reader ourselves when the song ends; only an unexpected exit is a failure.
      if (this.stopping || this.state === 'done' || this.state === 'failed') return;
      this.opts.log?.(`recorder: the reader exited (code ${code}, ${signal ?? 'no signal'})`);
      this.fail(`the audio reader stopped (${code}): ${err.trim().split('\n').pop() ?? ''}`);
    });
    this.opts.log?.(`recorder: listening on ${sink}.monitor`);
    const timeout = this.opts.silenceTimeoutMs ?? 30_000;
    this.silenceTimer = setTimeout(() => {
      if (this.state === 'waiting') this.fail('no audio reached the virtual speaker (is playback actually running?)');
    }, timeout);
    this.silenceTimer.unref();
  }

  /** Ends the recording early (the track reached its length, or the page said it ended). */
  async stop(): Promise<void> {
    if (this.stopping) return this.waitDone();
    this.stopping = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.parec?.kill('SIGTERM');
    const ff = this.ffmpeg;
    if (ff?.stdin && !ff.stdin.destroyed) {
      // Closing stdin makes ffmpeg write the final STREAMINFO block (length, MD5) into the file it already wrote.
      ff.stdin.end();
    }
    await this.waitDone();
  }

  waitDone(): Promise<void> {
    if (this.state === 'done' || this.state === 'failed') return Promise.resolve();
    return new Promise((resolve) => this.finishWaiters.push(resolve));
  }

  /* ------------------------------------------------------------------ internals */

  private onPcm(chunk: Buffer): void {
    if (this.state === 'failed' || this.state === 'done') return;
    const fb = this.frameSize;
    if (this.state === 'waiting') {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      const idx = firstAudibleFrame(this.pending, this.opts.channels, this.opts.threshold ?? 256);
      if (idx < 0) {
        if (this.pending.length > MAX_PENDING_BYTES) this.fail('the virtual speaker stayed silent');
        return;
      }
      const preRoll = Math.round((PRE_ROLL_FRAMES_MS / 1000) * this.opts.rate);
      const start = Math.max(0, idx - preRoll);
      this.trimmedFrames = start;
      // `pending` always starts on a frame boundary, so the slice is aligned too.
      const keep = this.pending.subarray(start * fb);
      this.pending = Buffer.alloc(0);
      this.begin();
      this.write(keep);
      return;
    }
    this.write(chunk);
  }

  private begin(): void {
    const { ffmpeg, file, rate, channels } = this.opts;
    const ff = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        String(rate),
        '-ac',
        String(channels),
        '-i',
        'pipe:0',
        '-c:a',
        'flac',
        '-compression_level',
        '5',
        '-f',
        'flac',
        '-y',
        file,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], env: this.opts.env ?? process.env },
    );
    this.ffmpeg = ff;
    let err = '';
    ff.stderr?.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-2000);
    });
    ff.on('error', (e) => this.fail(`could not start the encoder: ${e.message}`));
    ff.on('close', (code, signal) => {
      this.opts.log?.(`recorder: encoder exited (code ${code}, ${signal ?? 'no signal'}, ${this.frames} frames)`);
      if (this.state === 'failed') return;
      if (code !== 0 && !this.stopping) return this.fail(`the encoder stopped (${code}): ${err.trim().split('\n').pop() ?? ''}`);
      this.finish('done');
    });
    // Keep the reader and the encoder in step: a full pipe pauses the sink reader instead of buffering the song.
    ff.stdin?.on('drain', () => this.parec?.stdout?.resume());
    this.state = 'recording';
    this.opts.log?.(`recorder: first audio after ${this.trimmedFrames} frames of silence`);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.emit('started');
  }

  private write(chunk: Buffer): void {
    if (this.state !== 'recording' || !this.ffmpeg?.stdin) return;
    const fb = this.frameSize;
    let buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    if (buf.length % fb !== 0) {
      this.carry = Buffer.from(buf.subarray(buf.length - (buf.length % fb)));
      buf = buf.subarray(0, buf.length - (buf.length % fb));
    }
    const frames = buf.length / fb;
    if (this.opts.maxFrames > 0 && this.frames + frames > this.opts.maxFrames) {
      const keep = Math.max(0, (this.opts.maxFrames - this.frames) * fb);
      buf = buf.subarray(0, keep);
      this.frames += keep / fb;
      this.measure(buf);
      if (keep > 0) this.ffmpeg.stdin.write(buf);
      void this.stop();
      return;
    }
    this.frames += frames;
    this.measure(buf);
    if (!this.ffmpeg.stdin.write(buf)) this.parec?.stdout?.pause();
  }

  private measure(buf: Buffer): void {
    const l = levels(buf);
    if (l.peakDb > this.maxPeak) this.maxPeak = l.peakDb;
    if (l.rmsDb > this.maxRms) this.maxRms = l.rmsDb;
    this.levels = { peakDb: this.maxPeak, rmsDb: this.maxRms };
  }

  private fail(msg: string): void {
    if (this.state === 'failed' || this.state === 'done') return;
    this.error = msg;
    this.state = 'failed';
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.parec?.kill('SIGTERM');
    this.ffmpeg?.kill('SIGTERM');
    try {
      fs.rmSync(this.opts.file, { force: true });
    } catch {
      /* ignore */
    }
    this.emit('failed', msg);
    this.finish('failed');
  }

  private finish(state: 'done' | 'failed'): void {
    if (this.state === 'done' || this.state === 'failed') {
      this.flush();
      return;
    }
    this.state = state;
    this.parec?.kill('SIGTERM');
    this.flush();
  }

  private flush(): void {
    const waiters = this.finishWaiters;
    this.finishWaiters = [];
    for (const w of waiters) w();
    this.emit('end');
  }
}

/**
 * A small stereo WAV (s16) with a sine tone — the selftest plays this through the engine's own speaker, so the capture
 * path can be proven without Spotify. Leading silence is included on purpose: the recorder must drop it.
 */
export function toneWav(opts: { seconds: number; rate: number; channels: number; freq?: number; amplitude?: number; silenceMs?: number }): Buffer {
  const { seconds, rate, channels } = opts;
  const freq = opts.freq ?? 440;
  const amplitude = opts.amplitude ?? 0.25;
  const silenceFrames = Math.round(((opts.silenceMs ?? 0) / 1000) * rate);
  const toneFrames = Math.round(seconds * rate);
  const frames = silenceFrames + toneFrames;
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < toneFrames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amplitude * 32767);
    for (let c = 0; c < channels; c++) data.writeInt16LE(v, ((silenceFrames + i) * channels + c) * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
