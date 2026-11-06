/*
 * Google Cast (Chromecast) sender, loaded lazily from gstatic (allowed by the CSP) and only in Chrome. The receiver is
 * Google's Default Media Receiver; it fetches the track from Reddify's signed /cast/<token> URL (no session needed).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = any;

declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean) => void;
    cast?: AnyObj;
    chrome?: AnyObj;
  }
}

export interface CastMedia {
  url: string;
  contentType: string;
  title: string;
  artist: string;
  album: string;
  cover: string | null;
  startSeconds: number;
}

export interface CastEvents {
  onState(connected: boolean, device: string | null): void;
  onProgress(position: number, duration: number, playing: boolean): void;
  onEnded(): void;
}

let loading: Promise<boolean> | null = null;

export function castSupported(): boolean {
  return /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent) && window.isSecureContext;
}

function loadSdk(): Promise<boolean> {
  if (!castSupported()) return Promise.resolve(false);
  loading ??= new Promise((resolve) => {
    window.__onGCastApiAvailable = (ok) => resolve(ok);
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.async = true;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    window.setTimeout(() => resolve(false), 15_000);
  });
  return loading;
}

export class CastController {
  private ctx: AnyObj = null;
  private player: AnyObj = null;
  private controller: AnyObj = null;
  private lastMediaUrl: string | null = null;
  private endedFor: string | null = null;
  available = false;

  constructor(private readonly events: CastEvents) {}

  async init(): Promise<boolean> {
    if (this.ctx) return true;
    if (!(await loadSdk())) return false;
    const cast = window.cast;
    const chrome = window.chrome;
    if (!cast?.framework || !chrome?.cast) return false;
    this.ctx = cast.framework.CastContext.getInstance();
    this.ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    this.player = new cast.framework.RemotePlayer();
    this.controller = new cast.framework.RemotePlayerController(this.player);
    const E = cast.framework.RemotePlayerEventType;
    this.controller.addEventListener(E.IS_CONNECTED_CHANGED, () => {
      const session = this.ctx.getCurrentSession();
      this.events.onState(!!this.player.isConnected, session?.getCastDevice()?.friendlyName ?? null);
    });
    const progress = () => this.events.onProgress(this.player.currentTime ?? 0, this.player.duration ?? 0, !this.player.isPaused);
    this.controller.addEventListener(E.CURRENT_TIME_CHANGED, progress);
    this.controller.addEventListener(E.IS_PAUSED_CHANGED, progress);
    this.controller.addEventListener(E.PLAYER_STATE_CHANGED, () => {
      // IDLE after PLAYING with reason FINISHED = the track ended on the TV.
      const st = this.player.playerState;
      const media = this.ctx.getCurrentSession()?.getMediaSession();
      if (st === 'IDLE' && media?.idleReason === 'FINISHED' && this.lastMediaUrl && this.endedFor !== this.lastMediaUrl) {
        this.endedFor = this.lastMediaUrl;
        this.events.onEnded();
      }
    });
    this.available = true;
    return true;
  }

  get connected(): boolean {
    return !!this.player?.isConnected;
  }

  async requestSession(): Promise<boolean> {
    if (!(await this.init())) return false;
    try {
      await this.ctx.requestSession();
      return true;
    } catch {
      return false;
    }
  }

  endSession(): void {
    this.ctx?.getCurrentSession()?.endSession(true);
  }

  async load(m: CastMedia): Promise<void> {
    const session = this.ctx?.getCurrentSession();
    if (!session) throw new Error('No cast session');
    const chrome = window.chrome;
    const info = new chrome.cast.media.MediaInfo(m.url, m.contentType);
    info.streamType = chrome.cast.media.StreamType.BUFFERED;
    const md = new chrome.cast.media.MusicTrackMediaMetadata();
    md.title = m.title;
    md.artist = m.artist;
    md.albumName = m.album;
    if (m.cover) md.images = [new chrome.cast.Image(m.cover)];
    info.metadata = md;
    const req = new chrome.cast.media.LoadRequest(info);
    req.autoplay = true;
    req.currentTime = m.startSeconds;
    this.lastMediaUrl = m.url;
    this.endedFor = null;
    await session.loadMedia(req);
  }

  playOrPause(): void {
    this.controller?.playOrPause();
  }

  seek(sec: number): void {
    if (!this.player) return;
    this.player.currentTime = sec;
    this.controller.seek();
  }

  setVolume(v: number): void {
    if (!this.player) return;
    this.player.volumeLevel = v;
    this.controller.setVolumeLevel();
  }
}
