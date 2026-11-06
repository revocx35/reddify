import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Card, CoverRef, Track } from '../../../shared/api';
import { api } from '../api/client';
import { likes, useLiked } from '../player/likes';
import { myPlaylists, useMyPlaylists } from '../player/playlists';
import { type PlayContext, player, usePlayer } from '../player/player';
import { Icon } from './Icon';

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function Spinner({ size = 24 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />;
}

/** An image with graceful fallbacks: Spotify CDN → the library's cached cover → a music-note tile. */
export function Img({ src, trackId, alt, round, className }: { src: string | null | undefined; trackId?: string; alt: string; round?: boolean; className?: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [src, trackId]);
  const url = stage === 0 && src ? src : stage <= 1 && trackId ? `/api/cover/${trackId}` : null;
  if (!url) {
    return (
      <span className={`img img-empty ${round ? 'round' : ''} ${className ?? ''}`} aria-label={alt}>
        <Icon name="music" size={28} />
      </span>
    );
  }
  return (
    <img
      className={`img ${round ? 'round' : ''} ${className ?? ''}`}
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setStage((s) => (s === 0 && src && trackId ? 1 : 2))}
    />
  );
}

export function cardLink(c: Card): string {
  return c.kind === 'track' ? `/album/${c.track?.album?.id ?? ''}` : `/${c.kind}/${c.id}`;
}

export function PlayButton({ onClick, playing, size = 48, label = 'Play' }: { onClick: () => void; playing?: boolean; size?: number; label?: string }) {
  return (
    <button
      className="play-fab"
      style={{ width: size, height: size }}
      aria-label={playing ? 'Pause' : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Icon name={playing ? 'pause' : 'play'} size={size * 0.45} />
    </button>
  );
}

/** Plays an album/playlist/artist card directly from the grid (loads its tracks first). */
async function playCard(c: Card): Promise<void> {
  if (c.kind === 'track' && c.track) return player.playTrack(c.track, { kind: 'home', id: c.id, name: c.name });
  if (c.kind === 'album') {
    const a = await api.album(c.id);
    player.playList(a.tracks, 0, { kind: 'album', id: c.id, name: a.album.name });
  } else if (c.kind === 'playlist') {
    const p = await api.playlist(c.id);
    player.playList(p.tracks, 0, { kind: 'playlist', id: c.id, name: p.playlist.name });
  } else if (c.kind === 'artist') {
    const a = await api.artist(c.id);
    player.playList(a.topTracks, 0, { kind: 'artist', id: c.id, name: a.artist.name });
  }
}

export function CardTile({ c }: { c: Card }) {
  const navigate = useNavigate();
  const st = usePlayer();
  const active = st.context?.id === c.id || (c.kind === 'track' && player.current?.id === c.id);
  const onOpen = () => {
    if (c.kind === 'track' && c.track) {
      if (c.track.album) navigate(`/album/${c.track.album.id}`);
      else void playCard(c);
    } else navigate(cardLink(c));
  };
  return (
    <div className="card" role="link" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="card-art">
        <Img src={c.image} trackId={c.kind === 'track' ? c.id : undefined} alt={c.name} round={c.kind === 'artist'} />
        <span className="card-play">
          <PlayButton playing={active && st.playing} onClick={() => (active ? player.toggle() : void playCard(c))} />
        </span>
      </div>
      <div className="card-title" title={c.name}>
        {c.name}
      </div>
      <div className="card-sub">{c.subtitle}</div>
    </div>
  );
}

export function Shelf({ title, items, to }: { title: string; items: Card[]; to?: string }) {
  if (!items.length) return null;
  return (
    <section className="shelf">
      <div className="shelf-head">
        <h2>{to ? <Link to={to}>{title}</Link> : title}</h2>
      </div>
      <div className="shelf-row">
        {items.map((c) => (
          <CardTile key={`${c.kind}:${c.id}`} c={c} />
        ))}
      </div>
    </section>
  );
}

export function Artists({ track }: { track: Track }) {
  return (
    <span className="artists">
      {track.artists.map((a, i) => (
        <span key={a.id}>
          {i ? ', ' : ''}
          <Link to={`/artist/${a.id}`} onClick={(e) => e.stopPropagation()}>
            {a.name}
          </Link>
        </span>
      ))}
    </span>
  );
}

export function LikeButton({ id, size = 18 }: { id: string; size?: number }) {
  const liked = useLiked(id);
  return (
    <button
      className={`icon-btn like ${liked ? 'on' : ''}`}
      aria-label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
      title={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}
      onClick={(e) => {
        e.stopPropagation();
        void likes.toggle(id);
      }}
    >
      <Icon name={liked ? 'heartFill' : 'heart'} size={size} />
    </button>
  );
}

export interface MenuAction {
  label: string;
  icon: string;
  run: () => void;
}

/** A Reddify playlist's cover: 2x2 mosaic of four album covers, else the first cover, else a note. */
export function PlaylistCover({ covers, className, alt = '' }: { covers: CoverRef[]; className?: string; alt?: string }) {
  if (covers.length >= 4) {
    return (
      <span className={`img mosaic ${className ?? ''}`} aria-label={alt}>
        {covers.slice(0, 4).map((c) => (
          <Img key={c.trackId} src={c.url} trackId={c.trackId} alt="" />
        ))}
      </span>
    );
  }
  const c = covers[0];
  return <Img src={c?.url ?? null} trackId={c?.trackId} alt={alt} className={className} />;
}

/** "Add to playlist" list: a new playlist, then the user's playlists (check mark = already in it). */
function AddToPlaylistMenu({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const lists = useMyPlaylists();
  const [has, setHas] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    void myPlaylists.refresh();
    if (ids.length === 1) api.trackPlaylists(ids[0]!).then((x) => setHas(new Set(x)), () => undefined);
  }, [ids]);
  const shown = lists.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <>
      {lists.length > 6 ? (
        <input className="menu-filter" placeholder="Find a playlist" value={filter} onChange={(e) => setFilter(e.target.value)} onClick={(e) => e.stopPropagation()} autoFocus />
      ) : null}
      <button
        role="menuitem"
        onClick={(e) => {
          e.stopPropagation();
          onDone();
          void myPlaylists.create(ids).then((p) => p && navigate(`/my/${p.id}`));
        }}
      >
        <Icon name="plus" size={16} /> New playlist
      </button>
      <div className="menu-sep" />
      <div className="menu-scroll">
        {shown.map((p) => (
          <button
            key={p.id}
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              onDone();
              void myPlaylists.add(p, ids);
            }}
          >
            <Icon name={has.has(p.id) ? 'check' : 'music'} size={16} /> <span className="menu-text">{p.name}</span>
          </button>
        ))}
        {!lists.length ? <div className="menu-label">No playlists yet</div> : null}
      </div>
    </>
  );
}

/** Small "…" menu for a track. `extra` adds context actions (e.g. "Remove from this playlist"). */
export function TrackMenu({ t, extra = [] }: { t: Track; extra?: MenuAction[] }) {
  const [open, setOpen] = useState<false | 'main' | 'playlists'>(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const item = (label: string, icon: string, fn: () => void, keep = false) => (
    <button
      key={label}
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        if (!keep) setOpen(false);
        fn();
      }}
    >
      <Icon name={icon} size={16} /> {label}
    </button>
  );
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        className="icon-btn"
        aria-label={`More options for ${t.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => (o ? false : 'main'));
        }}
      >
        <Icon name="more" size={18} />
      </button>
      {open === 'playlists' ? (
        <div className="menu" role="menu">
          {item('Back', 'back', () => setOpen('main'), true)}
          <div className="menu-sep" />
          <AddToPlaylistMenu ids={[t.id]} onDone={() => setOpen(false)} />
        </div>
      ) : open ? (
        <div className="menu" role="menu">
          {item('Add to playlist', 'playlistAdd', () => setOpen('playlists'), true)}
          {extra.map((x) => item(x.label, x.icon, x.run))}
          {item('Play next', 'queue', () => player.playNext(t))}
          {item('Add to queue', 'plus', () => player.addToQueue(t))}
          {item(likes.has(t.id) ? 'Remove from Liked Songs' : 'Save to Liked Songs', 'heart', () => void likes.toggle(t.id))}
          {t.album ? item('Go to album', 'music', () => navigate(`/album/${t.album!.id}`)) : null}
          {t.artists[0] ? item('Go to artist', 'user', () => navigate(`/artist/${t.artists[0]!.id}`)) : null}
          {item('Download file', 'download', () => {
            const a = document.createElement('a');
            a.href = api.downloadUrl(t.id);
            a.rel = 'noopener';
            a.click();
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Spotify-style track table. `showAlbum` adds the album column; `numbered` shows positions instead of covers. */
export function TrackList({
  tracks,
  context,
  showAlbum = true,
  numbered = false,
  showCover = true,
  menuExtra,
  onMove,
}: {
  tracks: Track[];
  context: PlayContext;
  showAlbum?: boolean;
  numbered?: boolean;
  showCover?: boolean;
  menuExtra?: (t: Track, i: number) => MenuAction[];
  /** Enables drag-and-drop reordering (own playlists): called with the old and new index. */
  onMove?: (from: number, to: number) => void;
}) {
  const st = usePlayer();
  const cur = st.queue[st.index];
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  return (
    <div className={`tracklist ${showAlbum ? 'with-album' : ''}`} role="table">
      <div className="tl-head" role="row">
        <span>#</span>
        <span>Title</span>
        {showAlbum ? <span className="tl-album">Album</span> : null}
        <span className="tl-dur">
          <Icon name="clock" size={16} />
        </span>
      </div>
      {tracks.map((t, i) => {
        const active = cur?.id === t.id;
        return (
          <div
            key={`${t.id}:${i}`}
            role="row"
            className={`tl-row ${active ? 'active' : ''} ${t.playable ? '' : 'dim'} ${drag?.over === i && drag.from !== i ? (drag.from < i ? 'drop-below' : 'drop-above') : ''}`}
            draggable={!!onMove}
            onDragStart={onMove ? (e) => (e.dataTransfer.setData('text/plain', t.name), (e.dataTransfer.effectAllowed = 'move'), setDrag({ from: i, over: i })) : undefined}
            onDragOver={onMove ? (e) => (e.preventDefault(), drag && drag.over !== i && setDrag({ ...drag, over: i })) : undefined}
            onDrop={onMove ? (e) => (e.preventDefault(), drag && drag.from !== i && onMove(drag.from, i), setDrag(null)) : undefined}
            onDragEnd={onMove ? () => setDrag(null) : undefined}
            onDoubleClick={() => player.playList(tracks, i, context)}
            onClick={(e) => {
              // Touch screens: one tap plays (there is no double click).
              if (window.matchMedia('(hover: none)').matches) {
                e.preventDefault();
                player.playList(tracks, i, context);
              }
            }}
          >
            <span className="tl-num">
              <span className="n">{active && st.playing ? <span className="eq" aria-label="Playing" /> : numbered ? i + 1 : i + 1}</span>
              <button className="icon-btn tl-play" aria-label={`Play ${t.name}`} onClick={() => (active ? player.toggle() : player.playList(tracks, i, context))}>
                <Icon name={active && st.playing ? 'pause' : 'play'} size={16} />
              </button>
            </span>
            <span className="tl-title">
              {showCover ? <Img src={t.cover} trackId={t.id} alt="" className="tl-cover" /> : null}
              <span className="tl-text">
                <span className="tl-name">{t.name}</span>
                <span className="tl-sub">
                  {t.explicit ? <span className="explicit">E</span> : null}
                  {t.cached ? (
                    <span className="cached" title="In your library (plays offline)">
                      <Icon name="downloaded" size={14} />
                    </span>
                  ) : null}
                  <Artists track={t} />
                </span>
              </span>
            </span>
            {showAlbum ? (
              <span className="tl-album">{t.album ? <Link to={`/album/${t.album.id}`}>{t.album.name}</Link> : null}</span>
            ) : null}
            <span className="tl-dur">
              <LikeButton id={t.id} size={16} />
              <span>{t.durationMs ? fmtTime(t.durationMs / 1000) : ''}</span>
              <TrackMenu t={t} extra={menuExtra?.(t, i)} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error-box">
      <Icon name="warning" size={28} />
      <p>{error}</p>
      {retry ? (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Loading() {
  return (
    <div className="center-pad">
      <Spinner size={32} />
    </div>
  );
}

/** Loads data for a page, with loading and error states. */
export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    setData(null);
    fn(ctl.signal)
      .then((d) => !ctl.signal.aborted && setData(d))
      .catch((e: unknown) => !ctl.signal.aborted && setError(e instanceof Error ? e.message : 'Something went wrong.'));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

export function PageHeader({
  kind,
  title,
  image,
  round,
  children,
  trackId,
}: {
  kind: string;
  title: string;
  image: string | null;
  round?: boolean;
  children?: ReactNode;
  trackId?: string;
}) {
  return (
    <header className="page-header">
      <Img src={image} trackId={trackId} alt={title} round={round} className="ph-art" />
      <div className="ph-text">
        <span className="ph-kind">{kind}</span>
        <h1 className={title.length > 28 ? 'long' : ''}>{title}</h1>
        <div className="ph-meta">{children}</div>
      </div>
    </header>
  );
}
