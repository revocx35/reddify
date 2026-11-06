import { useSyncExternalStore } from 'react';
import type { MyPlaylist } from '../../../shared/api';
import { api } from '../api/client';
import { toast } from '../components/toast';

/** The signed-in user's own Reddify playlists (sidebar, library, "Add to playlist" menus). */
class MyPlaylists {
  list: MyPlaylist[] = [];
  private version = 0;
  private readonly listeners = new Set<() => void>();

  async refresh(): Promise<void> {
    try {
      this.list = await api.myPlaylists();
      this.emit();
    } catch {
      /* keep the old list */
    }
  }

  /** Puts a changed playlist at the top (most recently updated first, like the server orders them). */
  upsert(p: MyPlaylist): void {
    this.list = [p, ...this.list.filter((x) => x.id !== p.id)];
    this.emit();
  }

  remove(id: number): void {
    this.list = this.list.filter((x) => x.id !== id);
    this.emit();
  }

  async create(tracks: string[] = [], name?: string): Promise<MyPlaylist | null> {
    try {
      const r = await api.createPlaylist({ tracks, name });
      this.upsert(r.playlist);
      return r.playlist;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not create the playlist.');
      return null;
    }
  }

  async add(p: MyPlaylist, ids: string[]): Promise<void> {
    try {
      const r = await api.addToPlaylist(p.id, ids);
      this.upsert(r.playlist);
      toast(r.added ? `Added to ${p.name}` : `Already in ${p.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add to the playlist.');
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

export const myPlaylists = new MyPlaylists();

export function useMyPlaylists(): MyPlaylist[] {
  useSyncExternalStore(myPlaylists.subscribe, myPlaylists.getVersion);
  return myPlaylists.list;
}
