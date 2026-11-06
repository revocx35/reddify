import { useSyncExternalStore } from 'react';
import type { Track } from '../../../shared/api';
import { api } from '../api/client';
import { CastController } from './cast';

export type Repeat = 'off' | 'all' | 'one';

export interface PlayContext {
  kind: 'album' | 'playlist' | 'artist' | 'search' | 'liked' | 'library' | 'home' | 'track';
  id: string;
  name: string;
}

export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  /** Waiting for the first bytes (first play = matching + download start). */
  loading: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  error: string | null;
  context: PlayContext | null;
  castDevice: string | null;
  /** Tracks appended by autoplay ("Recommended") start at this index; -1 = none. */
  autoplayFrom: number;
}

const initial: PlayerState = {
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off',
  volume: Number(localStorage.getItem('reddify.volume') ?? '0.8') || 0.8,
  error: null,
  context: null,
  castDevice: null,
  autoplayFrom: -1,
};

function shuffled<T>(a: T[]): T[] {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
}

/**
 * The player: one <audio> element fed from /api/stream/<id> (first play streams while the server downloads), a queue
 * with shuffle/repeat, Spotify-recommendation autoplay when the queue runs out, prefetching of the next track, the
 * Media Session API (lock screen / hardware keys) and Chromecast handoff.
 */
export class Player {
  private state: PlayerState = initial;
  private readonly listeners = new Set<() => void>();
  readonly audio: HTMLAudioElement;
  readonly cast: CastController;
  private loadSeq = 0;
  private reportedFor: string | null = null;
  private prefetchedFor: string | null = null;
  private original: Track[] | null = null;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = this.state.volume;
    const a = this.audio;
    a.addEventListener('timeupdate', () => this.onTime(a.currentTime, a.duration));
    a.addEventListener('playing', () => this.set({ playing: true, loading: false, error: null }));
    a.addEventListener('pause', () => this.set({ playing: false }));
    a.addEventListener('waiting', () => this.set({ loading: true }));
    a.addEventListener('canplay', () => this.set({ loading: false }));
    a.addEventListener('ended', () => void this.onEnded());
    a.addEventListener('error', () => {
      if (!a.src) return;
      void this.explainError();
    });
    this.cast = new CastController({
      onState: (connected, device) => void this.onCastState(connected, device),
      onProgress: (pos, dur, playing) => {
        if (!this.state.castDevice) return;
        this.set({ playing, loading: false });
        this.onTime(pos, dur);
      },
      onEnded: () => void this.onEnded(),
    });
    this.setupMediaSession();
  }

  /* --------------------------------------------------------------------- store */

  getState = (): PlayerState => this.state;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get current(): Track | null {
    return this.state.queue[this.state.index] ?? null;
  }

  /* ------------------------------------------------------------------- actions */

  playList(tracks: Track[], start: number, context: PlayContext | null): void {
    const list = tracks.filter(Boolean);
    if (!list.length) return;
    let queue = list;
    let index = Math.max(0, Math.min(start, list.length - 1));
    this.original = null;
    if (this.state.shuffle) {
      this.original = list;
      const first = list[index]!;
      queue = [first, ...shuffled(list.filter((_, i) => i !== index))];
      index = 0;
    }
    this.set({ queue, index, context, autoplayFrom: -1, error: null });
    void this.load(0);
  }

  playTrack(t: Track, context: PlayContext | null = null): void {
    this.playList([t], 0, context ?? { kind: 'track', id: t.id, name: t.name });
  }

  playNext(t: Track): void {
    if (this.state.index < 0) return this.playTrack(t);
    const q = this.state.queue.slice();
    q.splice(this.state.index + 1, 0, t);
    this.set({ queue: q });
  }

  addToQueue(t: Track): void {
    if (this.state.index < 0) return this.playTrack(t);
    const q = this.state.queue.slice();
    const at = this.state.autoplayFrom >= 0 ? this.state.autoplayFrom : q.length;
    q.splice(at, 0, t);
    this.set({ queue: q, autoplayFrom: this.state.autoplayFrom >= 0 ? this.state.autoplayFrom + 1 : -1 });
  }

  removeFromQueue(i: number): void {
    if (i <= this.state.index) return;
    const q = this.state.queue.slice();
    q.splice(i, 1);
    this.set({ queue: q, autoplayFrom: this.state.autoplayFrom > i ? this.state.autoplayFrom - 1 : this.state.autoplayFrom });
  }

  jumpTo(i: number): void {
    if (i < 0 || i >= this.state.queue.length) return;
    this.set({ index: i });
    void this.load(0);
  }

  toggle(): void {
    if (!this.current) return;
    if (this.state.castDevice) return this.cast.playOrPause();
    if (this.audio.paused) {
      if (!this.audio.src) void this.load(this.state.position);
      else void this.audio.play().catch(() => undefined);
    } else this.audio.pause();
  }

  next(): void {
    const { index, queue, repeat } = this.state;
    if (index + 1 < queue.length) {
      this.set({ index: index + 1 });
      void this.load(0);
    } else if (repeat === 'all' && queue.length) {
      this.set({ index: 0 });
      void this.load(0);
    } else {
      void this.autoplay(true);
    }
  }

  prev(): void {
    if (this.state.position > 3 || this.state.index <= 0) return this.seek(0);
    this.set({ index: this.state.index - 1 });
    void this.load(0);
  }

  seek(sec: number): void {
    const s = Math.max(0, sec);
    if (this.state.castDevice) this.cast.seek(s);
    else if (this.audio.src) this.audio.currentTime = s;
    this.set({ position: s });
  }

  setVolume(v: number): void {
    const vol = Math.max(0, Math.min(1, v));
    this.audio.volume = vol;
    if (this.state.castDevice) this.cast.setVolume(vol);
    localStorage.setItem('reddify.volume', String(vol));
    this.set({ volume: vol });
  }

  toggleShuffle(): void {
    const on = !this.state.shuffle;
    const { queue, index } = this.state;
    if (on && queue.length > 1) {
      this.original = queue;
      const head = queue.slice(0, index + 1);
      this.set({ shuffle: true, queue: [...head, ...shuffled(queue.slice(index + 1))] });
    } else if (!on && this.original) {
      const cur = this.current;
      const orig = this.original;
      this.original = null;
      const i = cur ? orig.findIndex((t) => t.id === cur.id) : -1;
      this.set({ shuffle: false, queue: i >= 0 ? orig : queue, index: i >= 0 ? i : index });
    } else this.set({ shuffle: on });
  }

  cycleRepeat(): void {
    const order: Repeat[] = ['off', 'all', 'one'];
    this.set({ repeat: order[(order.indexOf(this.state.repeat) + 1) % 3]! });
  }

  async startCast(): Promise<void> {
    await this.cast.requestSession();
  }

  stopCast(): void {
    this.cast.endSession();
  }

  /* ------------------------------------------------------------------ internals */

  private async load(startAt: number): Promise<void> {
    const t = this.current;
    if (!t) return;
    const seq = ++this.loadSeq;
    this.reportedFor = null;
    this.prefetchedFor = null;
    this.set({ loading: true, position: startAt, duration: t.durationMs / 1000, error: null });
    this.updateMediaSession(t);
    if (this.state.castDevice) {
      try {
        const c = await api.cast(t.id);
        if (seq !== this.loadSeq) return;
        await this.cast.load({
          url: c.url,
          contentType: c.contentType,
          title: t.name,
          artist: t.artists.map((a) => a.name).join(', '),
          album: t.album?.name ?? '',
          cover: c.cover,
          startSeconds: startAt,
        });
      } catch (e) {
        if (seq === this.loadSeq) this.set({ loading: false, error: e instanceof Error ? e.message : 'Cast failed' });
      }
      return;
    }
    try {
      // Starts matching + download on the server; the stream below serves bytes as soon as they exist.
      const p = await api.prepare(t.id);
      if (seq !== this.loadSeq) return;
      if (p.status === 'failed') throw new Error(p.error ?? 'This song could not be found.');
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.set({ loading: false, playing: false, error: e instanceof Error ? e.message : 'Could not play' });
      return;
    }
    this.audio.src = api.streamUrl(t.id);
    if (startAt) this.audio.currentTime = startAt;
    try {
      await this.audio.play();
    } catch {
      /* autoplay policy or error: the 'error' handler explains */
    }
  }

  private async explainError(): Promise<void> {
    const t = this.current;
    if (!t) return;
    const s = await api.status(t.id).catch(() => null);
    const unsupported = this.audio.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED && s?.status === 'ready';
    this.set({
      loading: false,
      playing: false,
      error: s?.error ?? (unsupported ? 'This browser cannot play AAC audio (use Chrome, Firefox, Safari or the app).' : 'Playback failed.'),
    });
  }

  private onTime(pos: number, dur: number): void {
    const t = this.current;
    const duration = Number.isFinite(dur) && dur > 0 ? dur : (t?.durationMs ?? 0) / 1000;
    this.set({ position: pos, duration });
    if (!t) return;
    // Count a play after 30 s (or half of a short track).
    if (this.reportedFor !== t.id && (pos > 30 || (duration > 0 && pos > duration / 2))) {
      this.reportedFor = t.id;
      void api.played(t.id).catch(() => undefined);
    }
    // Get the next track ready on the server 15 s in (it is matched + downloaded by then).
    if (this.prefetchedFor !== t.id && pos > 15) {
      this.prefetchedFor = t.id;
      const nxt = this.state.queue[this.state.index + 1];
      if (nxt && !nxt.cached) void api.prepare(nxt.id).catch(() => undefined);
      else if (!nxt) void this.autoplay(false);
    }
    if ('mediaSession' in navigator && duration > 0 && pos <= duration) {
      try {
        navigator.mediaSession.setPositionState({ duration, position: pos, playbackRate: 1 });
      } catch {
        /* ignore */
      }
    }
  }

  private async onEnded(): Promise<void> {
    if (this.state.repeat === 'one') {
      this.seek(0);
      if (this.state.castDevice) void this.load(0);
      else void this.audio.play();
      return;
    }
    this.next();
  }

  /** Appends Spotify's recommendations for the current track when the queue is about to run out. */
  private async autoplay(andPlay: boolean): Promise<void> {
    const cur = this.current;
    if (!cur || this.state.repeat !== 'off') return;
    if (this.state.index + 1 >= this.state.queue.length) {
      const recs = await api.recommendations(cur.id).catch(() => [] as Track[]);
      const have = new Set(this.state.queue.map((t) => t.id));
      const add = recs.filter((t) => !have.has(t.id));
      if (add.length) {
        const from = this.state.queue.length;
        this.set({ queue: [...this.state.queue, ...add], autoplayFrom: this.state.autoplayFrom >= 0 ? this.state.autoplayFrom : from });
        if (!andPlay && !add[0]!.cached) void api.prepare(add[0]!.id).catch(() => undefined);
      }
    }
    if (andPlay && this.state.index + 1 < this.state.queue.length) {
      this.set({ index: this.state.index + 1 });
      void this.load(0);
    } else if (andPlay) {
      this.set({ playing: false });
    }
  }

  private async onCastState(connected: boolean, device: string | null): Promise<void> {
    const wasCasting = !!this.state.castDevice;
    if (connected && !wasCasting) {
      const pos = this.audio.src ? this.audio.currentTime : this.state.position;
      this.audio.pause();
      this.set({ castDevice: device ?? 'Chromecast' });
      if (this.current) void this.load(pos);
    } else if (!connected && wasCasting) {
      const pos = this.state.position;
      this.set({ castDevice: null, playing: false });
      if (this.current) {
        this.audio.src = api.streamUrl(this.current.id);
        this.audio.currentTime = pos;
      }
    }
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('seekto', (d) => d.seekTime !== undefined && this.seek(d.seekTime));
  }

  private updateMediaSession(t: Track): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name ?? '',
      artwork: t.cover ? [{ src: t.cover, sizes: '300x300', type: 'image/jpeg' }] : [],
    });
  }
}

export const player = new Player();

export function usePlayer(): PlayerState {
  return useSyncExternalStore(player.subscribe, player.getState);
}
