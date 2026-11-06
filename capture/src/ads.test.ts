import { describe, expect, it } from 'vitest';
import { adResolverRules } from './chrome.js';

describe('ad host blocking', () => {
  const rules = adResolverRules();

  it('sends Spotify advert and ad-telemetry hosts to a dead address', () => {
    expect(rules).toContain('MAP ads-fa.spotify.com 127.0.0.1');
    expect(rules).toContain('MAP adeventtracker.spotify.com 127.0.0.1');
    expect(rules).toContain('MAP securepubads.g.doubleclick.net 127.0.0.1');
  });

  it('never touches the hosts that carry the music or the player’s API', () => {
    // Blocking any of these would break playback instead of the advert: the audio CDNs, the pathfinder/API, the
    // login, and the image CDN the UI needs.
    for (const host of ['spclient.wg.spotify.com', 'api-partner.spotify.com', 'audio4-ak.spotify.com', 'i.scdn.co', 'accounts.spotify.com']) {
      expect(rules).not.toContain(host);
    }
  });
});
