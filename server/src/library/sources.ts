import type { AudioSource } from '../../../shared/api.js';

/**
 * Which audio connection a track is fetched from. A plain source has no fallback (ask for Spotify and a Spotify failure
 * is a failure); a `-preferred` source tries its own connection first and then the other one, so a track Spotify will
 * not play still plays from YouTube Music and vice versa.
 */
export type Provider = 'youtube' | 'spotify';

export const AUDIO_SOURCES: readonly AudioSource[] = ['youtube', 'spotify', 'youtube-preferred', 'spotify-preferred'];

export const SOURCE_LABELS: Record<AudioSource, string> = {
  youtube: 'YouTube Music only',
  spotify: 'Spotify only',
  'youtube-preferred': 'YouTube Music first, Spotify as fallback',
  'spotify-preferred': 'Spotify first, YouTube Music as fallback',
};

/** The provider names shown to the user when an attempt fails. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  youtube: 'YouTube Music',
  spotify: 'Spotify',
};

export function isAudioSource(v: unknown): v is AudioSource {
  return typeof v === 'string' && (AUDIO_SOURCES as readonly string[]).includes(v);
}

/** The providers to try, in order. */
export function sourceOrder(source: AudioSource): Provider[] {
  switch (source) {
    case 'youtube':
      return ['youtube'];
    case 'spotify':
      return ['spotify'];
    case 'youtube-preferred':
      return ['youtube', 'spotify'];
    case 'spotify-preferred':
      return ['spotify', 'youtube'];
  }
}
