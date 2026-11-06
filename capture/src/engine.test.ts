import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureConfig } from './config.js';
import { type Job, Engine } from './engine.js';

type Fake = { duration: number; paused: boolean; mine: boolean };

/** confirmTrack against a scripted player: each tick (500 ms) reads the next state, the last one repeats. */
function engineWith(states: Fake[]) {
  const e = new Engine({ idleStopMinutes: 0 } as CaptureConfig);
  const chrome = (e as unknown as { chrome: Record<string, unknown> }).chrome;
  let i = 0;
  const cur = () => states[Math.min(i, states.length - 1)]!;
  chrome.player = vi.fn(async () => {
    const s = cur();
    i++;
    return { position: 10, duration: s.duration, ended: false, paused: s.paused, volume: 1, muted: false, title: null, artist: null };
  });
  chrome.trackPagePlaying = vi.fn(async () => states[Math.min(i - 1, states.length - 1)]!.mine);
  const pressPlay = vi.fn(async () => undefined);
  chrome.pressPlay = pressPlay;
  const confirm = (job: Partial<Job>) => (e as unknown as { confirmTrack: (j: Job) => Promise<boolean> }).confirmTrack({ trackId: 't', durationMs: 218_000, ...job } as Job);
  return { confirm, pressPlay };
}

describe('confirmTrack', () => {
  afterEach(() => vi.useRealTimers());

  it("does not take a leftover now-playing bar of the right length for this page's track", async () => {
    vi.useFakeTimers();
    // The bar still shows this track from an earlier attempt (paused), then the page's own button starts it.
    const { confirm, pressPlay } = engineWith([...Array(12).fill({ duration: 218, paused: true, mine: false }), { duration: 218, paused: false, mine: true }]);
    let settled = false;
    const p = confirm({}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_500);
    expect(settled).toBe(false);
    expect(pressPlay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe(true);
  });

  it('never accepts another song left paused in the bar (Liked Songs), and keeps pressing the page button', async () => {
    vi.useFakeTimers();
    const { confirm, pressPlay } = engineWith([{ duration: 417, paused: true, mine: false }]);
    const p = confirm({});
    await vi.advanceTimersByTimeAsync(181_000);
    await expect(p).resolves.toBe(false);
    expect(pressPlay.mock.calls.length).toBeGreaterThan(30);
  });

  it('waits out a playing advert without pressing anything', async () => {
    vi.useFakeTimers();
    const { confirm, pressPlay } = engineWith([...Array(20).fill({ duration: 30, paused: false, mine: false }), { duration: 218, paused: false, mine: true }]);
    const p = confirm({});
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(p).resolves.toBe(true);
    expect(pressPlay).not.toHaveBeenCalled();
  });
});
