import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recorder, firstAudibleFrame, frameBytes, levels, toneWav } from './audio.js';

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
