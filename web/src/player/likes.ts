import { useSyncExternalStore } from 'react';
import { api } from '../api/client';

/** The signed-in user's liked track ids (Reddify's own "Liked Songs", works offline too). */
class Likes {
  private ids = new Set<string>();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.ids = new Set(await api.likedIds());
      this.emit();
    } catch {
      this.loaded = false;
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  async toggle(id: string): Promise<void> {
    const on = !this.ids.has(id);
    if (on) this.ids.add(id);
    else this.ids.delete(id);
    this.emit();
    try {
      await api.like(id, on);
    } catch {
      if (on) this.ids.delete(id);
      else this.ids.add(id);
      this.emit();
    }
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getVersion = () => this.version;
}

export const likes = new Likes();

export function useLiked(id: string | undefined): boolean {
  useSyncExternalStore(likes.subscribe, likes.getVersion);
  return !!id && likes.has(id);
}
