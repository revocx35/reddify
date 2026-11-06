import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chrome } from './chrome.js';
import type { CaptureConfig } from './config.js';

/** openTrack with the browser stubbed out: only the page check is real. */
function stubbed(rendered: () => boolean) {
  const c = new Chrome({} as CaptureConfig);
  const goto = vi.spyOn(c, 'goto').mockResolvedValue(undefined);
  vi.spyOn(c, 'ensureVolume').mockResolvedValue(undefined);
  vi.spyOn(c, 'evaluate').mockImplementation(async () => rendered() as never);
  return { c, goto };
}

describe('openTrack', () => {
  it("waits for the track page's own play button, not the now-playing bar's (that one renders first)", async () => {
    const { c } = stubbed(() => true);
    const evaluate = vi.mocked(c.evaluate);
    await c.openTrack('4qqMifvtYd4drJsSohaTss');
    const js = String(evaluate.mock.calls[0]![0]);
    expect(js).toContain('[data-testid="action-bar-row"] [data-testid="play-button"]');
    expect(js).not.toContain('control-button-playpause');
  });

  afterEach(() => vi.useRealTimers());

  it('accepts a track page whose play button is on screen', async () => {
    const { c, goto } = stubbed(() => true);
    await expect(c.openTrack('4qqMifvtYd4drJsSohaTss')).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith('https://open.spotify.com/track/4qqMifvtYd4drJsSohaTss');
  });

  it('keeps waiting through a check that throws mid-navigation', async () => {
    let n = 0;
    const { c, goto } = stubbed(() => {
      if (++n < 3) throw new Error('Execution context was destroyed');
      return true;
    });
    await expect(c.openTrack('4qqMifvtYd4drJsSohaTss')).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('reloads once, then gives up on a page that never renders', async () => {
    vi.useFakeTimers();
    const { c, goto } = stubbed(() => false);
    const p = c.openTrack('4qqMifvtYd4drJsSohaTss');
    const done = expect(p).rejects.toThrow('Spotify did not render the track page.');
    await vi.advanceTimersByTimeAsync(60_000);
    await done;
    expect(goto).toHaveBeenCalledTimes(2);
  });
});

describe('pressPlay', () => {
  function withPage(answer: unknown) {
    const c = new Chrome({} as CaptureConfig);
    const evaluate = vi.spyOn(c, 'evaluate').mockResolvedValue(answer as never);
    const sent: unknown[] = [];
    (c as unknown as { cdp: unknown }).cdp = { send: async (m: string, p: unknown) => sent.push([m, p]) };
    (c as unknown as { sessionId: string }).sessionId = 's';
    return { c, evaluate, sent };
  }

  it("clicks the track page's own button, never the first play-button in the page (the sidebar's Liked Songs)", async () => {
    const { c, evaluate, sent } = withPage({ x: 355, y: 316 });
    await c.pressPlay();
    const js = String(evaluate.mock.calls[0]![0]);
    expect(js).toContain('[data-testid="action-bar-row"] [data-testid="play-button"]');
    expect(js).not.toMatch(/querySelector\('\[data-testid="play-button"\]'\)/);
    expect(js).not.toContain('control-button-playpause');
    expect(sent).toHaveLength(2);
  });

  it('does not toggle a track that is already playing', async () => {
    const { c, sent } = withPage('playing');
    await c.pressPlay();
    expect(sent).toHaveLength(0);
  });

  it('refuses to fall back to the now-playing bar when the page has no button', async () => {
    const { c, sent } = withPage(null);
    await expect(c.pressPlay()).rejects.toThrow('the track page has no play button');
    expect(sent).toHaveLength(0);
  });
});

describe('seekToStart', () => {
  afterEach(() => vi.useRealTimers());

  /** A player whose clock only moves to 0 when `rewindOn` (a CDP input event) arrives. */
  function player(rewindOn: 'click' | 'home' | 'never') {
    const c = new Chrome({} as CaptureConfig);
    let position = 129;
    vi.spyOn(c, 'evaluate').mockImplementation(async (js: string) => (js.includes('focus()') ? true : { x: 446, y: 975 }) as never);
    vi.spyOn(c, 'player').mockImplementation(async () => ({ position, duration: 218, ended: false, paused: true, volume: 1, muted: false, title: null, artist: null }));
    const sent: string[] = [];
    (c as unknown as { cdp: unknown }).cdp = {
      send: async (m: string, p: { type: string; key?: string }) => {
        sent.push(`${m}:${p.type}`);
        if (rewindOn === 'click' && p.type === 'mouseReleased') position = 0;
        if (rewindOn === 'home' && p.key === 'Home' && p.type === 'keyUp') position = 0;
      },
    };
    (c as unknown as { sessionId: string }).sessionId = 's';
    return { c, sent };
  }

  it('rewinds with a click on the bar', async () => {
    vi.useFakeTimers();
    const { c } = player('click');
    const p = c.seekToStart();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe(true);
  });

  it('never uses the keyboard (Spotify applies a Home key seconds later, mid-recording)', async () => {
    vi.useFakeTimers();
    const { c, sent } = player('home');
    const p = c.seekToStart();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBe(false);
    expect(sent.some((x) => x.startsWith('Input.dispatchKeyEvent'))).toBe(false);
  });

  it('gives up after three tries instead of hanging', async () => {
    vi.useFakeTimers();
    const { c, sent } = player('never');
    const p = c.seekToStart();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBe(false);
    expect(sent.filter((s) => s === 'Input.dispatchMouseEvent:mouseReleased')).toHaveLength(3);
  });
});

describe('pause, then rewind (the race seen on the deployment)', () => {
  afterEach(() => vi.useRealTimers());

  it('does not accept a rewind that snaps back to where the player was', async () => {
    vi.useFakeTimers();
    const c = new Chrome({} as CaptureConfig);
    vi.spyOn(c, 'evaluate').mockImplementation(async (js: string) => (js.includes('focus()') ? true : { x: 446, y: 975 }) as never);
    // The bar shows 0:00 right after every seek, then the player's own state (2:25) wins again.
    let reads = 0;
    vi.spyOn(c, 'player').mockImplementation(async () => ({ position: reads++ % 2 === 0 ? 0 : 145, duration: 218, ended: false, paused: true, volume: 1, muted: false, title: null, artist: null }));
    (c as unknown as { cdp: unknown }).cdp = { send: async () => undefined };
    (c as unknown as { sessionId: string }).sessionId = 's';
    const p = c.seekToStart();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBe(false);
  });

  it('waits until the pause has landed and the clock stands still', async () => {
    vi.useFakeTimers();
    const c = new Chrome({} as CaptureConfig);
    const pause = vi.spyOn(c, 'pressPause').mockResolvedValue(undefined);
    const states = [
      { position: 145, paused: false },
      { position: 146, paused: true },
      { position: 146, paused: true },
    ];
    let i = 0;
    vi.spyOn(c, 'player').mockImplementation(async () => ({ ...states[Math.min(i++, states.length - 1)]!, duration: 218, ended: false, volume: 1, muted: false, title: null, artist: null }));
    let settled = false;
    const p = c.pauseAndSettle().finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe(true);
    expect(pause.mock.calls.length).toBe(2); // the first pause had not landed yet: pressed again
  });
});
