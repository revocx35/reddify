import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Track } from '../../../shared/api';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { toast } from '../components/toast';
import {
  CardTile,
  ErrorBox,
  Img,
  Loading,
  PageHeader,
  PlayButton,
  PlaylistCover,
  Shelf,
  TrackList,
  fmtNumber,
  fmtTime,
  useLoad,
} from '../components/ui';
import { player, usePlayer } from '../player/player';
import { library, useLibrary } from '../player/library';
import { myPlaylists, useMyPlaylists } from '../player/playlists';
import { useAuth } from '../state';

function OfflineBanner() {
  return (
    <div className="offline-banner">
      <Icon name="offline" size={18} /> Spotify is not reachable right now. You are seeing songs from Reddify's library; they all still play.
    </div>
  );
}

function greetingNow(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* -------------------------------------------------------------------------- home */

export function HomePage() {
  const { me } = useAuth();
  const { data, error, reload } = useLoad((s) => api.home(s), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const quick = data.sections.flatMap((s) => s.items).filter((c) => c.kind !== 'track' && c.kind !== 'artist').slice(0, 8);
  return (
    <div className="page home">
      <div className="home-gradient" />
      {data.offline ? <OfflineBanner /> : null}
      <h1 className="greeting">
        {greetingNow()}
        {me ? `, ${me.displayName}` : ''}
      </h1>
      {quick.length ? (
        <div className="quick-grid">
          {quick.map((c) => (
            <Link key={c.id} to={`/${c.kind}/${c.id}`} className="quick">
              <Img src={c.image} alt="" className="quick-art" />
              <span className="quick-name">{c.name}</span>
            </Link>
          ))}
        </div>
      ) : null}
      {data.sections.map((s) => (
        <Shelf key={s.title} title={s.title} items={s.items} />
      ))}
      {!data.sections.length ? <p className="muted center-pad">Nothing here yet. Search for a song to start.</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------ search */

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setText(q), [q]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text.trim() !== q) setParams(text.trim() ? { q: text.trim() } : {}, { replace: true });
    }, 350);
    return () => window.clearTimeout(t);
  }, [text, q, setParams]);
  return (
    <div className="page search">
      <div className="search-box">
        <Icon name="search" size={22} />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What do you want to play?"
          aria-label="Search"
          autoFocus
          enterKeyHint="search"
        />
        {text ? (
          <button className="icon-btn" aria-label="Clear search" onClick={() => (setText(''), inputRef.current?.focus())}>
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </div>
      {q ? <SearchResults q={q} /> : <SearchStart />}
    </div>
  );
}

function SearchStart() {
  const { data } = useLoad(() => api.recent(), []);
  return (
    <div>
      {data?.length ? (
        <>
          <h2 className="section-title">Recently played</h2>
          <TrackList tracks={data.slice(0, 10)} context={{ kind: 'library', id: 'recent', name: 'Recently played' }} />
        </>
      ) : (
        <p className="muted center-pad">Search Spotify's catalogue: songs, artists, albums and playlists.</p>
      )}
    </div>
  );
}

function SearchResults({ q }: { q: string }) {
  const { data, error, reload } = useLoad((s) => api.search(q, s), [q]);
  const [tab, setTab] = useState<'all' | 'songs' | 'artists' | 'albums' | 'playlists'>('all');
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const ctx = { kind: 'search' as const, id: q, name: `Search: ${q}` };
  const empty = !data.tracks.length && !data.artists.length && !data.albums.length && !data.playlists.length;
  return (
    <div>
      {data.offline ? <OfflineBanner /> : null}
      <div className="chips">
        {(['all', 'songs', 'artists', 'albums', 'playlists'] as const).map((t) => (
          <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {empty ? <p className="muted center-pad">No results found for “{q}”.</p> : null}
      {tab === 'all' ? (
        <>
          <div className="top-row">
            {data.top || data.tracks[0] ? (
              <section className="top-result">
                <h2 className="section-title">Top result</h2>
                <TopResult data={data} />
              </section>
            ) : null}
            {data.tracks.length ? (
              <section className="top-songs">
                <h2 className="section-title">Songs</h2>
                <TrackList tracks={data.tracks.slice(0, 4)} context={ctx} showAlbum={false} />
              </section>
            ) : null}
          </div>
          <Shelf title="Artists" items={data.artists} />
          <Shelf title="Albums" items={data.albums} />
          <Shelf title="Playlists" items={data.playlists} />
        </>
      ) : tab === 'songs' ? (
        <AllSongs q={q} first={data.tracks} offline={data.offline} />
      ) : (
        <div className="grid">
          {(tab === 'artists' ? data.artists : tab === 'albums' ? data.albums : data.playlists).map((c) => (
            <CardTile key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function TopResult({ data }: { data: NonNullable<ReturnType<typeof useLoad<Awaited<ReturnType<typeof api.search>>>>['data']> }) {
  const navigate = useNavigate();
  const c = data.top ?? (data.tracks[0] ? { kind: 'track' as const, id: data.tracks[0].id, name: data.tracks[0].name, subtitle: '', image: data.tracks[0].cover, track: data.tracks[0] } : null);
  if (!c) return null;
  const t = c.kind === 'track' ? (c.track ?? null) : null;
  const go = () => (t ? t.album && navigate(`/album/${t.album.id}`) : navigate(`/${c.kind}/${c.id}`));
  return (
    <div className="top-card" onClick={go} role="link" tabIndex={0}>
      <Img src={c.image} trackId={t?.id} alt="" round={c.kind === 'artist'} className="top-art" />
      <div className="top-name">{c.name}</div>
      <div className="top-sub">
        <span className="pill">{c.kind === 'track' ? 'Song' : c.kind[0]!.toUpperCase() + c.kind.slice(1)}</span>
        {t ? t.artists.map((a) => a.name).join(', ') : c.kind === 'artist' ? null : c.subtitle}
      </div>
      <span className="card-play">
        <PlayButton
          onClick={() => {
            if (t) player.playTrack(t);
            else go();
          }}
        />
      </span>
    </div>
  );
}

function AllSongs({ q, first, offline }: { q: string; first: Track[]; offline: boolean }) {
  const [tracks, setTracks] = useState<Track[]>(first);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (offline) return;
    api
      .searchTracks(q, 0)
      .then((p) => {
        setTracks(p.tracks);
        setTotal(p.total);
      })
      .catch(() => undefined);
  }, [q, offline]);
  const more = async () => {
    setBusy(true);
    try {
      const p = await api.searchTracks(q, tracks.length);
      setTracks((t) => [...t, ...p.tracks.filter((x) => !t.some((y) => y.id === x.id))]);
      setTotal(p.total);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <TrackList tracks={tracks} context={{ kind: 'search', id: q, name: `Search: ${q}` }} />
      {total !== null && tracks.length < total && tracks.length < 500 ? (
        <div className="center-pad">
          <button className="btn" onClick={() => void more()} disabled={busy}>
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- album / artist */

function useAccent(): void {
  /* reserved for per-page gradient colours */
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const { data, error, reload } = useLoad(() => api.album(id), [id]);
  const st = usePlayer();
  useAccent();
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const a = data.album;
  const total = data.tracks.reduce((s, t) => s + t.durationMs, 0) / 1000;
  const playing = st.context?.id === a.id && st.playing;
  return (
    <div className="page detail">
      <PageHeader kind={a.type === 'single' ? 'Single' : a.type === 'ep' ? 'EP' : 'Album'} title={a.name} image={a.cover}>
        {a.artists.map((ar, i) => (
          <span key={ar.id}>
            {i ? ' • ' : ''}
            <Link to={`/artist/${ar.id}`} className="strong">
              {ar.name}
            </Link>
          </span>
        ))}
        {a.year ? <span> • {a.year}</span> : null}
        <span>
          {' '}
          • {data.tracks.length} songs, {Math.round(total / 60)} min
        </span>
      </PageHeader>
      <div className="action-bar">
        <PlayButton size={56} playing={playing} onClick={() => (st.context?.id === a.id ? player.toggle() : player.playList(data.tracks, 0, { kind: 'album', id: a.id, name: a.name }))} />
        <ShuffleButton onClick={() => playShuffled(data.tracks, { kind: 'album', id: a.id, name: a.name })} />
      </div>
      <TrackList tracks={data.tracks} context={{ kind: 'album', id: a.id, name: a.name }} showAlbum={false} showCover={false} numbered />
      {a.label ? <p className="muted small label-line">℗ {a.label}</p> : null}
    </div>
  );
}

function ShuffleButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn big" aria-label="Shuffle play" onClick={onClick}>
      <Icon name="shuffle" size={28} />
    </button>
  );
}

function playShuffled(tracks: Track[], ctx: Parameters<typeof player.playList>[2]): void {
  if (!player.getState().shuffle) player.toggleShuffle();
  player.playList(tracks, Math.floor(Math.random() * tracks.length), ctx);
}

export function ArtistPage() {
  const { id = '' } = useParams();
  const { data, error, reload } = useLoad(() => api.artist(id), [id]);
  const st = usePlayer();
  const [more, setMore] = useState(false);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const a = data.artist;
  const ctx = { kind: 'artist' as const, id: a.id, name: a.name };
  return (
    <div className="page detail">
      <header className={`artist-hero ${a.header ? 'with-image' : ''}`}>
        {a.header ? <Img src={a.header} alt="" className="hero-bg" /> : <Img src={a.image} alt="" round className="ph-art" />}
        <div className="hero-text">
          <span className="ph-kind">Artist</span>
          <h1>{a.name}</h1>
          {a.monthlyListeners !== null ? <div className="ph-meta">{fmtNumber(a.monthlyListeners)} monthly listeners</div> : null}
        </div>
      </header>
      <div className="action-bar">
        <PlayButton size={56} playing={st.context?.id === a.id && st.playing} onClick={() => (st.context?.id === a.id ? player.toggle() : player.playList(data.topTracks, 0, ctx))} />
        <ShuffleButton onClick={() => playShuffled(data.topTracks, ctx)} />
      </div>
      <h2 className="section-title">Popular</h2>
      <TrackList tracks={more ? data.topTracks : data.topTracks.slice(0, 5)} context={ctx} showAlbum={false} />
      {data.topTracks.length > 5 ? (
        <button className="link-btn" onClick={() => setMore((m) => !m)}>
          {more ? 'Show less' : 'See more'}
        </button>
      ) : null}
      <Shelf title="Albums" items={data.albums} />
      <Shelf title="Singles and EPs" items={data.singles} />
      <Shelf title="Fans also like" items={data.related} />
    </div>
  );
}

/* ------------------------------------------------------------------------ playlist */

export function PlaylistPage() {
  const { id = '' } = useParams();
  const { data, error, reload } = useLoad(() => api.playlist(id), [id]);
  const [extra, setExtra] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();
  const st = usePlayer();
  useEffect(() => setExtra([]), [id]);
  const tracks = useMemo(() => [...(data?.tracks ?? []), ...extra], [data, extra]);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const p = data.playlist;
  const ctx = { kind: 'playlist' as const, id: p.id, name: p.name };
  /** Spotify playlists are read-only here: copy all songs (up to 1000) into a new Reddify playlist instead. */
  const saveCopy = async () => {
    setSaving(true);
    try {
      const all = [...tracks];
      while (all.length < Math.min(data.total, 1000)) {
        const r = await api.playlist(id, all.length);
        if (!r.tracks.length) break;
        all.push(...r.tracks);
      }
      const np = await myPlaylists.create(all.slice(0, 1000).map((t) => t.id), p.name);
      if (np) {
        toast(`Saved as ${np.name}`);
        navigate(`/my/${np.id}`);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not copy the playlist.');
    } finally {
      setSaving(false);
    }
  };
  const loadMore = async () => {
    setBusy(true);
    try {
      const r = await api.playlist(id, tracks.length);
      setExtra((e) => [...e, ...r.tracks]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page detail">
      <PageHeader kind="Playlist" title={p.name} image={p.image}>
        {p.description ? <p className="ph-desc">{p.description}</p> : null}
        <span className="strong">{p.owner}</span>
        <span> • {data.total} songs</span>
      </PageHeader>
      <div className="action-bar">
        <PlayButton size={56} playing={st.context?.id === p.id && st.playing} onClick={() => (st.context?.id === p.id ? player.toggle() : player.playList(tracks, 0, ctx))} />
        <ShuffleButton onClick={() => playShuffled(tracks, ctx)} />
        <button className="btn btn-outline" disabled={saving} onClick={() => void saveCopy()} title="Make an editable copy in Your Library">
          <Icon name="playlistAdd" size={18} /> {saving ? 'Saving…' : 'Save as my playlist'}
        </button>
      </div>
      <TrackList tracks={tracks} context={ctx} />
      {tracks.length < data.total ? (
        <div className="center-pad">
          <button className="btn" onClick={() => void loadMore()} disabled={busy}>
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------------- library */

export function CollectionPage() {
  const { data, editing } = useLibrary();
  const mine = useMyPlaylists();
  const navigate = useNavigate();
  useEffect(() => {
    void library.refresh();
    void myPlaylists.refresh();
  }, []);
  // Leave edit mode when the page is left, so the sidebar does not stay in it unnoticed.
  useEffect(() => () => library.setEditing(false), []);
  const remove = (label: string, onClick: () => void) =>
    editing ? (
      <button className="card-remove" aria-label={label} title={label} onClick={(e) => (e.preventDefault(), e.stopPropagation(), onClick())}>
        <Icon name="close" size={16} />
      </button>
    ) : null;
  return (
    <div className={`page${editing ? ' lib-editing' : ''}`}>
      <div className="page-title-row">
        <h1 className="page-title">Your Library</h1>
        <div className="page-title-actions">
          <button className={`btn ${editing ? 'btn-accent' : 'btn-outline'}`} aria-pressed={editing} onClick={() => library.setEditing(!editing)}>
            <Icon name={editing ? 'check' : 'edit'} size={18} /> {editing ? 'Done' : 'Edit'}
          </button>
          <button className="btn btn-outline" onClick={() => void myPlaylists.create().then((p) => p && navigate(`/my/${p.id}`))}>
            <Icon name="plus" size={18} /> Create playlist
          </button>
        </div>
      </div>
      {editing ? <p className="muted">Tap ✕ to remove. Spotify playlists, albums and artists are only removed from Reddify; your Spotify account keeps them.</p> : null}
      <div className="grid">
        <Link to="/collection/liked" className="card liked-card">
          <div className="liked-art">
            <Icon name="heartFill" size={48} />
          </div>
          <div className="card-title">Liked Songs</div>
          <div className="card-sub">{data?.liked ?? 0} songs</div>
        </Link>
        <Link to="/collection/downloads" className="card liked-card">
          <div className="liked-art lib">
            <Icon name="downloaded" size={48} />
          </div>
          <div className="card-title">Library</div>
          <div className="card-sub">{data?.downloaded ?? 0} downloaded songs</div>
        </Link>
        <Link to="/collection/recent" className="card liked-card">
          <div className="liked-art recent">
            <Icon name="clock" size={48} />
          </div>
          <div className="card-title">Recently played</div>
          <div className="card-sub">Your history</div>
        </Link>
        <Link to="/collection/spotify" className="card liked-card">
          <div className="liked-art spotify">
            <Icon name="heart" size={48} />
          </div>
          <div className="card-title">Spotify Liked Songs</div>
          <div className="card-sub">From your Spotify account</div>
        </Link>
        {mine.map((p) => (
          <Link key={`my${p.id}`} to={`/my/${p.id}`} className="card">
            <div className="card-art">
              <PlaylistCover covers={p.covers} alt={p.name} />
              {remove(`Delete ${p.name}`, () => void library.deleteMine(p))}
            </div>
            <div className="card-title" title={p.name}>
              {p.name}
            </div>
            <div className="card-sub">
              Playlist • {p.count} {p.count === 1 ? 'song' : 'songs'}
            </div>
          </Link>
        ))}
        {(data?.playlists ?? []).map((c) => (
          <div key={`${c.kind}${c.id}`} className="card-wrap">
            <CardTile c={c} />
            {remove(`Remove ${c.name} from Your Library`, () => void library.hide(c))}
          </div>
        ))}
      </div>
      {editing && data?.hidden.length ? (
        <>
          <h2 className="section-title">Removed from Your Library</h2>
          <div className="grid">
            {data.hidden.map((c) => (
              <div key={`h${c.kind}${c.id}`} className="card card-hidden">
                <div className="card-art">
                  <Img src={c.image} alt={c.name} round={c.kind === 'artist'} />
                </div>
                <div className="card-title" title={c.name}>
                  {c.name}
                </div>
                <button className="btn btn-outline small" onClick={() => void library.restore(c)}>
                  Restore
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function LikedPage() {
  const { data, error, reload } = useLoad(() => api.liked(), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  const ctx = { kind: 'liked' as const, id: 'liked', name: 'Liked Songs' };
  return (
    <div className="page detail">
      <header className="page-header liked-header">
        <div className="liked-art big">
          <Icon name="heartFill" size={72} />
        </div>
        <div className="ph-text">
          <span className="ph-kind">Playlist</span>
          <h1>Liked Songs</h1>
          <div className="ph-meta">{data.length} songs</div>
        </div>
      </header>
      <div className="action-bar">
        <PlayButton size={56} onClick={() => player.playList(data, 0, ctx)} />
        <ShuffleButton onClick={() => playShuffled(data, ctx)} />
      </div>
      {data.length ? <TrackList tracks={data} context={ctx} /> : <p className="muted center-pad">Songs you like will appear here. Tap the heart on any song.</p>}
    </div>
  );
}

export function SpotifyLikedPage() {
  const { data, error, reload } = useLoad(() => api.spotifyLiked(0), []);
  if (error)
    return (
      <div className="page">
        <ErrorBox error={`${error} Log Reddify's browser in to Spotify (Settings → Spotify connection) to see your Spotify likes.`} retry={reload} />
      </div>
    );
  if (!data) return <Loading />;
  const ctx = { kind: 'liked' as const, id: 'spotify-liked', name: 'Spotify Liked Songs' };
  return (
    <div className="page detail">
      <h1 className="page-title">Spotify Liked Songs</h1>
      <div className="action-bar">
        <PlayButton size={56} onClick={() => player.playList(data.tracks, 0, ctx)} />
      </div>
      <TrackList tracks={data.tracks} context={ctx} />
    </div>
  );
}

export function DownloadsPage() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, error, reload } = useLoad(() => api.downloads(query, 0), [query]);
  const ctx = { kind: 'library' as const, id: 'downloads', name: 'Library' };
  return (
    <div className="page detail">
      <h1 className="page-title">Library</h1>
      <p className="muted">Every song anyone played is kept here and plays without Spotify. {data ? `${data.total} songs.` : ''}</p>
      <div className="search-box small">
        <Icon name="search" size={18} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in the library" aria-label="Find in the library" />
      </div>
      {error ? <ErrorBox error={error} retry={reload} /> : !data ? <Loading /> : <TrackList tracks={data.tracks} context={ctx} />}
      {data?.tracks.length ? (
        <div className="action-bar">
          <PlayButton size={48} onClick={() => playShuffled(data.tracks, ctx)} label="Shuffle the library" />
          <span className="muted">Shuffle the library</span>
        </div>
      ) : null}
    </div>
  );
}

export function RecentPage() {
  const { data, error, reload } = useLoad(() => api.recent(), []);
  if (error) return <ErrorBox error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="page detail">
      <h1 className="page-title">Recently played</h1>
      {data.length ? <TrackList tracks={data} context={{ kind: 'library', id: 'recent', name: 'Recently played' }} /> : <p className="muted center-pad">Nothing yet.</p>}
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page center-pad">
      <h1>Page not found</h1>
      <Link to="/" className="btn">
        Home
      </Link>
    </div>
  );
}

export { fmtTime };
