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
