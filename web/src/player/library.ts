import { useSyncExternalStore } from 'react';
import type { Card, LibraryResponse, MyPlaylist } from '../../../shared/api';
import { api } from '../api/client';
import { toast } from '../components/toast';
import { myPlaylists } from './playlists';

/**
 * Your Library (sidebar + library page): the counts, the Spotify items and the edit mode. Removing a Spotify item only
 * hides it in Reddify (Spotify keeps it); removing an own playlist deletes it (it only exists in Reddify anyway).
 */
class Library {
  data: LibraryResponse | null = null;
  editing = false;
  private snap = { data: this.data, editing: this.editing };
  private readonly listeners = new Set<() => void>();

  async refresh(): Promise<void> {
    try {
      this.data = await api.library();
      this.emit();
    } catch {
      /* keep the old state */
    }
  }

  setEditing(on: boolean): void {
    this.editing = on;
    this.emit();
  }

  async hide(c: Card): Promise<void> {
    try {
      await api.hideLibraryItem(c.kind, c.id);
      if (this.data)
        this.data = { ...this.data, playlists: this.data.playlists.filter((x) => !same(x, c)), hidden: [c, ...this.data.hidden.filter((x) => !same(x, c))] };
      this.emit();
      toast(`Removed ${c.name} from Your Library (still on Spotify)`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove it.');
    }
  }

  async restore(c: Card): Promise<void> {
    try {
      await api.unhideLibraryItem(c.kind, c.id);
      toast(`${c.name} is back in Your Library`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not restore it.');
    }
    await this.refresh();
  }

  async deleteMine(p: MyPlaylist): Promise<void> {
    if (!window.confirm(`Delete “${p.name}”? It only exists in Reddify, so this cannot be undone.`)) return;
    try {
      await api.deletePlaylist(p.id);
      myPlaylists.remove(p.id);
      toast(`Deleted ${p.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the playlist.');
    }
  }

  private emit(): void {
    this.snap = { data: this.data, editing: this.editing };
    for (const l of this.listeners) l();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get = () => this.snap;
}

const same = (a: Card, b: Card) => a.kind === b.kind && a.id === b.id;

export const library = new Library();

export function useLibrary(): { data: LibraryResponse | null; editing: boolean } {
  return useSyncExternalStore(library.subscribe, library.get);
}
