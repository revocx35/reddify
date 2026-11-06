import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recorder, firstAudibleFrame, frameBytes, levels, tailCut, toneWav } from './audio.js';

const RATE = 44100;

/** Interleaved s16 stereo frames: `silent` frames of digital silence, then `loud` frames of full-scale tone. */
function pcm(silent: number, loud: number, channels = 2): Buffer {
  const buf = Buffer.alloc((silent + loud) * channels * 2);
  for (let f = silent; f < silent + loud; f++) {
    for (let c = 0; c < channels; c++) buf.writeInt16LE(12000, (f * channels + c) * 2);
  }
  return buf;
}

describe('recorder maths', () => {
  it('finds the first frame above the threshold, in stereo and in mono', () => {
    expect(frameBytes(2)).toBe(4);
    expect(firstAudibleFrame(pcm(1000, 10), 2, 256)).toBe(1000);
    expect(firstAudibleFrame(pcm(37, 10, 1), 1, 256)).toBe(37);
    expect(firstAudibleFrame(pcm(1000, 0), 2, 256)).toBe(-1);
    // A loud sample in one channel only still counts: the frame is audible.
    const one = pcm(5, 3);
    one.writeInt16LE(-8000, (5 * 2 + 1) * 2);
    expect(firstAudibleFrame(one, 2, 256)).toBe(5);
  });

  it('measures peak and RMS in dBFS', () => {
    const buf = Buffer.alloc(1000 * 4);
    for (let i = 0; i < 1000; i++) {
      buf.writeInt16LE(8192, i * 4); // 0.25 full scale on both channels: peak −12.04 dBFS, RMS the same
      buf.writeInt16LE(8192, i * 4 + 2);
    }
    const l = levels(buf);
    expect(l.peakDb).toBeCloseTo(-12, 0);
    expect(l.rmsDb).toBeCloseTo(-12, 0);
    expect(levels(Buffer.alloc(400))).toEqual({ peakDb: -100, rmsDb: -100 });
  });

  it('writes a valid WAV with the leading silence the selftest needs', () => {
    const wav = toneWav({ seconds: 1, rate: RATE, channels: 2, silenceMs: 250, freq: 440, amplitude: 0.25 });
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.subarray(36, 40).toString()).toBe('data');
    const frames = (wav.length - 44) / 4;
    expect(frames).toBe(RATE + Math.round(0.25 * RATE));
    expect(wav.readUInt32LE(24)).toBe(RATE); // sample rate
    expect(wav.readUInt16LE(22)).toBe(2); // channels
    // The silence is really silent, and the tone really oscillates.
    expect(firstAudibleFrame(wav.subarray(44), 2, 256)).toBeGreaterThanOrEqual(Math.round(0.25 * RATE));
    const l = levels(wav.subarray(44));
    expect(l.peakDb).toBeGreaterThan(-15);
    expect(l.peakDb).toBeLessThan(-10);
  });
});

describe('Recorder.stop', () => {
  it('ends a recording that never heard audio instead of waiting forever (it used to hang the engine queue)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf-rec-'));
    const silent = path.join(dir, 'silent-parec');
    fs.writeFileSync(silent, '#!/bin/sh\nexec cat /dev/zero\n', { mode: 0o755 });
    const rec = new Recorder({ file: path.join(dir, 'x.flac'), parec: silent, ffmpeg: 'false', pulseServer: 'x', sink: 'x', rate: RATE, channels: 2, maxFrames: 0 });
    rec.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(rec.state).toBe('waiting');
    const stopped = await Promise.race([rec.stop().then(() => 'stopped'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    expect(stopped).toBe('stopped');
    expect(rec.state).toBe('failed');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/** Stereo s16 PCM from segments: [frames, amplitude] (amplitude 0 = digital silence). */
function seg(...parts: [number, number][]): Buffer {
  const total = parts.reduce((n, [f]) => n + f, 0);
  const buf = Buffer.alloc(total * 4);
  let f0 = 0;
  for (const [frames, amp] of parts) {
    for (let f = f0; f < f0 + frames; f++) {
      const v = amp ? Math.round(amp * Math.sin(f / 7)) || amp : 0;
      buf.writeInt16LE(v, f * 4);
      buf.writeInt16LE(v, f * 4 + 2);
    }
    f0 += frames;
  }
  return buf;
}

describe('tailCut (the gap before the next song)', () => {
  const MIN = 3528; // 80 ms

  it('cuts at the start of the silence that is followed by the next song', () => {
    expect(tailCut(seg([20000, 6000], [11000, 0], [13000, 9000]), 2, MIN)).toBe(20000);
  });

  it('keeps a song that runs to the end, or ends in silence with nothing after it', () => {
    expect(tailCut(seg([44100, 6000]), 2, MIN)).toBe(-1);
    expect(tailCut(seg([30000, 6000], [14100, 0]), 2, MIN)).toBe(-1);
  });

  it('ignores pauses shorter than a song gap (and zero crossings)', () => {
    expect(tailCut(seg([20000, 6000], [2000, 0], [22100, 6000]), 2, MIN)).toBe(-1);
  });
});

describe.runIf(fs.existsSync('/usr/bin/ffmpeg'))('Recorder with a held-back tail (real ffmpeg)', () => {
  it('ends the file at the gap instead of recording the start of the next song', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf-rec-'));
    // 0.2 s silence (the moment before play), a 2.7 s song, a 0.15 s gap, then the next song: the 3 s cap (the track's
    // length counted from the first audible frame) would reach into the next song.
    const pcmFile = path.join(dir, 'in.pcm');
    fs.writeFileSync(pcmFile, seg([8820, 0], [119070, 6000], [6615, 0], [44100, 9000]));
    const fake = path.join(dir, 'fake-parec');
    fs.writeFileSync(fake, `#!/bin/sh\nexec cat ${pcmFile}\nsleep 5\n`, { mode: 0o755 });
    const file = path.join(dir, 'out.flac');
    const rec = new Recorder({ file, parec: fake, ffmpeg: '/usr/bin/ffmpeg', pulseServer: 'x', sink: 'x', rate: RATE, channels: 2, maxFrames: 3 * RATE, tailHoldMs: 1500 });
    rec.start();
    await rec.waitDone();
    expect(rec.state).toBe('done');
    // 25 ms pre-roll + the song, ending at the gap: nothing of the next song.
    expect(rec.frames).toBe(Math.round(0.025 * RATE) + 119070);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the full length when nothing follows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdf-rec-'));
    const pcmFile = path.join(dir, 'in.pcm');
    fs.writeFileSync(pcmFile, seg([8820, 0], [4 * RATE, 6000]));
    const fake = path.join(dir, 'fake-parec');
    fs.writeFileSync(fake, `#!/bin/sh\nexec cat ${pcmFile}\n`, { mode: 0o755 });
    const rec = new Recorder({ file: path.join(dir, 'out.flac'), parec: fake, ffmpeg: '/usr/bin/ffmpeg', pulseServer: 'x', sink: 'x', rate: RATE, channels: 2, maxFrames: 3 * RATE, tailHoldMs: 1500 });
    rec.start();
    await rec.waitDone();
    expect(rec.state).toBe('done');
    expect(rec.frames).toBe(3 * RATE);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
