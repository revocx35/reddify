import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { MyPlaylist, Track } from '../../../shared/api';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import { Artists, ErrorBox, Img, Loading, PlayButton, PlaylistCover, TrackList, fmtTime } from '../components/ui';
import { player, usePlayer } from '../player/player';
import { myPlaylists } from '../player/playlists';
import { useAuth } from '../state';

function lengthText(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

/** A playlist the user made in Reddify: play, rename, describe, reorder (drag), remove, delete, add songs. */
export function MyPlaylistPage() {
  const { id: raw = '' } = useParams();
  const id = Number(raw);
  const { me } = useAuth();
  const navigate = useNavigate();
  const st = usePlayer();
  const [p, setP] = useState<MyPlaylist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const [finding, setFinding] = useState(false);

  const load = () => {
    setError(null);
    api.myPlaylist(id).then(
      (r) => {
        setP(r.playlist);
        setTracks(r.tracks);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the playlist.'),
    );
  };
  useEffect(() => {
    setP(null);
    setFinding(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) return <ErrorBox error={error} retry={load} />;
  if (!p) return <Loading />;
  const ctx = { kind: 'playlist' as const, id: `my:${p.id}`, name: p.name };
  const changed = (np: MyPlaylist) => {
    setP(np);
    myPlaylists.upsert(np);
  };

  const remove = async (t: Track) => {
    setTracks((x) => x.filter((y) => y.id !== t.id));
    try {
      changed(await api.removeFromPlaylist(p.id, t.id));
      toast(`Removed from ${p.name}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the song.');
      load();
    }
  };
  const move = async (from: number, to: number) => {
    const t = tracks[from];
    if (!t) return;
    setTracks((x) => {
      const n = [...x];
      n.splice(from, 1);
      n.splice(to, 0, t);
      return n;
    });
    try {
      changed(await api.movePlaylistTrack(p.id, t.id, to));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not move the song.');
      load();
    }
  };
  const del = async () => {
    if (!window.confirm(`Delete “${p.name}”? This cannot be undone.`)) return;
    try {
      await api.deletePlaylist(p.id);
      myPlaylists.remove(p.id);
      toast('Removed from Your Library');
      navigate('/collection');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete the playlist.');
    }
  };
  const added = (np: MyPlaylist, t: Track) => {
    changed(np);
    setTracks((x) => (x.some((y) => y.id === t.id) ? x : [...x, t]));
  };

  return (
    <div className="page detail">
      <header className="page-header">
        <button className="ph-art-btn" onClick={() => setEditing(true)} aria-label="Edit details">
          <PlaylistCover covers={p.covers} className="ph-art" alt={p.name} />
          <span className="ph-art-edit">
            <Icon name="edit" size={40} />
            Choose details
          </span>
        </button>
        <div className="ph-text">
          <span className="ph-kind">Playlist</span>
          <h1 className={`clickable ${p.name.length > 28 ? 'long' : ''}`} onClick={() => setEditing(true)}>
            {p.name}
          </h1>
          <div className="ph-meta">
            {p.description ? <p className="ph-desc">{p.description}</p> : null}
            <span className="strong">{me?.displayName}</span>
            {p.count ? (
              <span>
                {' '}
                • {p.count} {p.count === 1 ? 'song' : 'songs'}, {lengthText(p.durationMs)}
              </span>
            ) : null}
          </div>
        </div>
      </header>
      <div className="action-bar">
        {tracks.length ? (
          <>
            <PlayButton size={56} playing={st.context?.id === ctx.id && st.playing} onClick={() => (st.context?.id === ctx.id ? player.toggle() : player.playList(tracks, 0, ctx))} />
            <button
              className="icon-btn big"
              aria-label="Shuffle play"
              onClick={() => {
                if (!player.getState().shuffle) player.toggleShuffle();
                player.playList(tracks, Math.floor(Math.random() * tracks.length), ctx);
              }}
            >
              <Icon name="shuffle" size={28} />
            </button>
          </>
        ) : null}
        <div className="menu-wrap">
          <button className="icon-btn big" aria-label={`More options for ${p.name}`} onClick={() => setMenu((m) => !m)}>
            <Icon name="more" size={28} />
          </button>
          {menu ? (
            <div className="menu left" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => (setMenu(false), setEditing(true))}>
                <Icon name="edit" size={16} /> Edit details
              </button>
              <button role="menuitem" onClick={() => (setMenu(false), setFinding(true))}>
                <Icon name="search" size={16} /> Add songs
              </button>
              {tracks.length ? (
                <button role="menuitem" onClick={() => (setMenu(false), tracks.forEach((t) => player.addToQueue(t)), toast('Added to queue'))}>
                  <Icon name="queue" size={16} /> Add to queue
                </button>
              ) : null}
              <button role="menuitem" onClick={() => (setMenu(false), void del())}>
                <Icon name="trash" size={16} /> Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {tracks.length ? (
        <TrackList tracks={tracks} context={ctx} onMove={(a, b) => void move(a, b)} menuExtra={(t) => [{ label: 'Remove from this playlist', icon: 'trash', run: () => void remove(t) }]} />
      ) : null}
      {!tracks.length || finding ? (
        <FindSongs playlist={p} have={new Set(tracks.map((t) => t.id))} onAdded={added} onClose={tracks.length ? () => setFinding(false) : undefined} />
      ) : (
        <div className="center-pad">
          <button className="btn" onClick={() => setFinding(true)}>
            Find more
          </button>
        </div>
      )}
      {editing ? <EditDetails p={p} onClose={() => setEditing(false)} onSaved={changed} /> : null}
    </div>
  );
}

/** "Let's find something for your playlist": Spotify search with an Add button per song. */
function FindSongs({ playlist, have, onAdded, onClose }: { playlist: MyPlaylist; have: Set<string>; onAdded: (p: MyPlaylist, t: Track) => void; onClose?: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Track[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) return setResults(null);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.search(query, ctl.signal).then(
        (r) => setResults(r.tracks),
        () => undefined,
      );
    }, 350);
    return () => (window.clearTimeout(t), ctl.abort());
  }, [q]);
  const add = async (t: Track) => {
    setBusy(t.id);
    try {
      const r = await api.addToPlaylist(playlist.id, [t.id]);
      onAdded(r.playlist, t);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the song.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="find-songs">
      <div className="find-head">
        <h2 className="section-title">Let's find something for your playlist</h2>
        {onClose ? (
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={24} />
          </button>
        ) : null}
      </div>
      <div className="search-box small">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for songs" aria-label="Search for songs" autoFocus={!!onClose} />
      </div>
      {results?.length ? (
        <div className="find-list">
          {results.map((t) => (
            <div key={t.id} className="find-row">
              <Img src={t.cover} trackId={t.id} alt="" className="tl-cover" />
              <span className="tl-text">
                <span className="tl-name">{t.name}</span>
                <span className="tl-sub">
                  <Artists track={t} />
                </span>
              </span>
              <span className="find-album muted">{t.album?.name}</span>
              <span className="muted small">{t.durationMs ? fmtTime(t.durationMs / 1000) : ''}</span>
              {have.has(t.id) ? (
                <span className="find-added" title="In this playlist">
                  <Icon name="check" size={18} />
                </span>
              ) : (
                <button className="btn btn-outline small" disabled={busy === t.id} onClick={() => void add(t)}>
                  Add
                </button>
              )}
            </div>
          ))}
        </div>
      ) : results ? (
        <p className="muted center-pad">No songs found for “{q.trim()}”.</p>
      ) : null}
    </section>
  );
}

function EditDetails({ p, onClose, onSaved }: { p: MyPlaylist; onClose: () => void; onSaved: (p: MyPlaylist) => void }) {
  const [name, setName] = useState(p.name);
  const [desc, setDesc] = useState(p.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Playlist name is required.');
    setBusy(true);
    try {
      onSaved(await api.updatePlaylist(p.id, { name: name.trim(), description: desc.trim() }));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <form onSubmit={save} className="form">
        <div className="dialog-head">
          <h2>Edit details</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="edit-grid">
          <PlaylistCover covers={p.covers} className="edit-art" />
          <div className="edit-fields">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Add a name" aria-label="Name" autoFocus />
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={300} placeholder="Add an optional description" aria-label="Description" />
          </div>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-foot">
          <button className="btn btn-accent" disabled={busy}>
            Save
          </button>
        </div>
        <p className="muted small">The cover is made from the first songs' album art. Playlists are private to you and stored on this Reddify server.</p>
      </form>
    </dialog>
  );
}
