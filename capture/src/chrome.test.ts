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
