import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Card } from '../../../shared/api';
import { Icon, Logo } from '../components/Icon';
import { toast, Toasts } from '../components/toast';
import { Artists, Img, LikeButton, PlaylistCover, fmtTime } from '../components/ui';
import { castSupported } from '../player/cast';
import { likes } from '../player/likes';
import { library, useLibrary } from '../player/library';
import { myPlaylists, useMyPlaylists } from '../player/playlists';
import { player, usePlayer } from '../player/player';
import { useAuth } from '../state';

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="icon-btn lib-remove" aria-label={label} title={label} onClick={onClick}>
      <Icon name="close" size={18} />
    </button>
  );
}

function SideLibrary() {
  const { data: lib, editing } = useLibrary();
  const mine = useMyPlaylists();
  const navigate = useNavigate();
  useEffect(() => {
    void library.refresh();
    void myPlaylists.refresh();
  }, []);
  const items: { to: string; name: string; sub: string; icon: string; img?: string | null; round?: boolean; card?: Card }[] = [
    { to: '/collection/liked', name: 'Liked Songs', sub: `Playlist • ${lib?.liked ?? 0} songs`, icon: 'heartFill' },
    { to: '/collection/downloads', name: 'Library', sub: `Downloaded • ${lib?.downloaded ?? 0} songs`, icon: 'downloaded' },
    { to: '/collection/recent', name: 'Recently played', sub: 'Your history', icon: 'clock' },
  ];
  const sp = (lib?.playlists ?? []).map((c: Card) => ({ to: `/${c.kind}/${c.id}`, name: c.name, sub: c.subtitle, icon: 'music', img: c.image, round: c.kind === 'artist', card: c }));
  return (
    <div className={`side-panel side-library${editing ? ' editing' : ''}`}>
      <div className="side-lib-head">
        <NavLink to="/collection" className="side-link">
          <Icon name="library" /> <span>Your Library</span>
        </NavLink>
        <span className="side-lib-actions">
          <button
            className={`icon-btn side-create${editing ? ' on' : ''}`}
            aria-label={editing ? 'Done editing Your Library' : 'Edit Your Library'}
            aria-pressed={editing}
            title={editing ? 'Done' : 'Edit (remove items)'}
            onClick={() => library.setEditing(!editing)}
          >
            <Icon name={editing ? 'check' : 'edit'} size={20} />
          </button>
          <button
            className="icon-btn side-create"
            aria-label="Create playlist"
            title="Create playlist"
            onClick={() => void myPlaylists.create().then((p) => p && (navigate(`/my/${p.id}`), toast(`Created ${p.name}`)))}
          >
            <Icon name="plus" size={20} />
          </button>
        </span>
      </div>
      {editing ? <p className="lib-edit-hint">Removing a Spotify item only hides it here; Spotify keeps it.</p> : null}
      <div className="side-lib-list">
        {mine.map((p) => (
          <div key={`my${p.id}`} className="lib-row">
            <NavLink to={`/my/${p.id}`} className="lib-item">
              <PlaylistCover covers={p.covers} className="lib-art" />
              <span className="lib-text">
                <span className="lib-name">{p.name}</span>
                <span className="lib-sub">
                  Playlist • {p.count} {p.count === 1 ? 'song' : 'songs'}
                </span>
              </span>
            </NavLink>
            {editing ? <RemoveButton label={`Delete ${p.name}`} onClick={() => void library.deleteMine(p)} /> : null}
          </div>
        ))}
        {[...items, ...sp].map((i) => (
          <div key={i.to} className="lib-row">
            <NavLink to={i.to} className="lib-item">
              {i.img !== undefined ? (
                <Img src={i.img} alt="" round={i.round} className="lib-art" />
              ) : (
                <span className={`lib-art lib-art-icon ${i.icon}`}>
                  <Icon name={i.icon} size={20} />
                </span>
              )}
              <span className="lib-text">
                <span className="lib-name">{i.name}</span>
                <span className="lib-sub">{i.sub}</span>
              </span>
            </NavLink>
            {editing && i.card ? <RemoveButton label={`Remove ${i.name} from Your Library`} onClick={() => void library.hide(i.card!)} /> : null}
          </div>
        ))}
        {editing && lib?.hidden.length ? (
          <>
            <div className="lib-hidden-title">Removed ({lib.hidden.length})</div>
            {lib.hidden.map((c) => (
              <div key={`h${c.kind}${c.id}`} className="lib-row lib-hidden">
                <span className="lib-item">
                  <Img src={c.image} alt="" round={c.kind === 'artist'} className="lib-art" />
                  <span className="lib-text">
                    <span className="lib-name">{c.name}</span>
                    <span className="lib-sub">{c.subtitle}</span>
                  </span>
                </span>
                <button className="btn btn-outline small" onClick={() => void library.restore(c)}>
                  Restore
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="side-panel side-nav">
        <NavLink to="/" className="side-brand" aria-label="Reddify home">
          <Logo size={34} wordmark />
        </NavLink>
        <NavLink to="/" end className="side-link">
          {({ isActive }) => (
            <>
              <Icon name={isActive ? 'homeFill' : 'home'} /> <span>Home</span>
            </>
          )}
        </NavLink>
        <NavLink to="/search" className="side-link">
          {({ isActive }) => (
            <>
              <Icon name={isActive ? 'searchFill' : 'search'} /> <span>Search</span>
            </>
          )}
        </NavLink>
      </div>
      <SideLibrary />
    </nav>
  );
}

function TopBar() {
  const navigate = useNavigate();
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="topbar">
      <div className="topbar-nav">
        <button className="round-btn" aria-label="Go back" onClick={() => navigate(-1)}>
          <Icon name="back" size={18} />
        </button>
        <button className="round-btn" aria-label="Go forward" onClick={() => navigate(1)}>
          <Icon name="forward" size={18} />
        </button>
      </div>
      <div className="topbar-right">
        <div className="menu-wrap">
          <button className="avatar" aria-label="Account menu" onClick={() => setOpen((o) => !o)}>
            {(me?.displayName ?? '?').slice(0, 1).toUpperCase()}
          </button>
          {open ? (
            <div className="menu right" role="menu" onMouseLeave={() => setOpen(false)}>
              <div className="menu-label">{me?.displayName}</div>
              <button role="menuitem" onClick={() => (setOpen(false), navigate('/settings'))}>
                <Icon name="settings" size={16} /> Settings
              </button>
              <button role="menuitem" onClick={() => (setOpen(false), navigate('/settings/spotify'))}>
                <Icon name="screen" size={16} /> Spotify connection
              </button>
              {me?.role === 'admin' ? (
                <button role="menuitem" onClick={() => (setOpen(false), navigate('/settings/admin'))}>
                  <Icon name="shield" size={16} /> Admin
                </button>
              ) : null}
              <button role="menuitem" onClick={() => void logout()}>
                <Icon name="logout" size={16} /> Log out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Progress({ compact }: { compact?: boolean }) {
  const st = usePlayer();
  const [drag, setDrag] = useState<number | null>(null);
  const dur = st.duration || 0;
  const pos = drag ?? st.position;
  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  return (
    <div className={`progress ${compact ? 'compact' : ''}`}>
      {compact ? null : <span className="time">{fmtTime(pos)}</span>}
      <input
        type="range"
        className="range"
        min={0}
        max={dur || 1}
        step={0.5}
        value={pos}
        aria-label="Seek"
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag !== null) player.seek(drag);
          setDrag(null);
        }}
        onKeyUp={() => {
          if (drag !== null) player.seek(drag);
          setDrag(null);
        }}
      />
      {compact ? null : <span className="time">{fmtTime(dur)}</span>}
    </div>
  );
}

function CastButton() {
  const st = usePlayer();
  if (!castSupported()) return null;
  return (
    <button
      className={`icon-btn ${st.castDevice ? 'on' : ''}`}
      aria-label={st.castDevice ? `Casting to ${st.castDevice}` : 'Cast to a device'}
      title={st.castDevice ? `Casting to ${st.castDevice} (click to stop)` : 'Cast to a device'}
      onClick={() => (st.castDevice ? player.stopCast() : void player.startCast())}
    >
      <Icon name={st.castDevice ? 'castOn' : 'cast'} size={18} />
    </button>
  );
}

function Controls() {
  const st = usePlayer();
  return (
    <div className="controls">
      <button
        className={`icon-btn ${st.shuffle ? 'on' : ''}`}
        aria-label={st.smart ? 'Smart Shuffle: on' : st.shuffle ? 'Shuffle: on' : 'Shuffle: off'}
        title={st.smart ? 'Smart Shuffle (adds recommendations; click to turn off)' : st.shuffle ? 'Shuffle (click for Smart Shuffle)' : 'Shuffle'}
        onClick={() => player.cycleShuffle()}
      >
        <Icon name={st.smart ? 'shuffleSmart' : 'shuffle'} size={18} />
      </button>
      <button className="icon-btn" aria-label="Previous" onClick={() => player.prev()}>
        <Icon name="prev" size={20} />
      </button>
      <button className="play-btn" aria-label={st.playing ? 'Pause' : 'Play'} onClick={() => player.toggle()} disabled={st.index < 0}>
        {st.loading ? <span className="spinner small dark" /> : <Icon name={st.playing ? 'pause' : 'play'} size={18} />}
      </button>
      <button className="icon-btn" aria-label="Next" onClick={() => player.next()}>
        <Icon name="next" size={20} />
      </button>
      <button
        className={`icon-btn ${st.repeat !== 'off' ? 'on' : ''} ${st.repeat === 'one' ? 'one' : ''}`}
        aria-label={`Repeat: ${st.repeat}`}
        onClick={() => player.cycleRepeat()}
      >
        <Icon name="repeat" size={18} />
      </button>
    </div>
  );
}

function QueuePanel({ onClose }: { onClose: () => void }) {
  const st = usePlayer();
  const cur = st.queue[st.index];
  const upcoming = st.queue.slice(st.index + 1).map((t, k) => ({ t, i: st.index + 1 + k }));
  const manual = upcoming.filter((u) => st.autoplayFrom < 0 || u.i < st.autoplayFrom);
  const auto = st.autoplayFrom >= 0 ? upcoming.filter((u) => u.i >= st.autoplayFrom) : [];
  const row = ({ t, i }: { t: (typeof st.queue)[number]; i: number }) => (
    <div key={`${t.id}:${i}`} className="q-row" onDoubleClick={() => player.jumpTo(i)}>
      <Img src={t.cover} trackId={t.id} alt="" className="q-art" />
      <span className="q-text" onClick={() => player.jumpTo(i)}>
        <span className="q-name">
          {st.smart && st.smartIds.includes(t.id) ? (
            <span className="smart-pick" title="Added by Smart Shuffle">
              <Icon name="sparkle" size={12} />
            </span>
          ) : null}
          {t.name}
        </span>
        <span className="q-sub">{t.artists.map((a) => a.name).join(', ')}</span>
      </span>
      <button className="icon-btn" aria-label="Remove from queue" onClick={() => player.removeFromQueue(i)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
  return (
    <aside className="side-panel queue-panel" aria-label="Queue">
      <div className="q-head">
        <h2>Queue</h2>
        <button className="icon-btn" aria-label="Close queue" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {cur ? (
        <>
          <h3>Now playing</h3>
          {row({ t: cur, i: st.index })}
        </>
      ) : (
        <p className="muted">Nothing is playing.</p>
      )}
      {manual.length ? (
        <h3>
          Next{st.context ? ` from: ${st.context.name}` : ''}
          {st.smart ? <span className="muted small"> · Smart Shuffle</span> : null}
        </h3>
      ) : null}
      {manual.map(row)}
      {auto.length ? <h3>Recommended next (autoplay)</h3> : null}
      {auto.map(row)}
    </aside>
  );
}

function PlayerBar({ onQueue, onExpand }: { onQueue: () => void; onExpand: () => void }) {
  const st = usePlayer();
  const t = st.queue[st.index];
  return (
    <footer className="playerbar">
      <div className="pb-left">
        {t ? (
          <>
            <button className="pb-art-btn" onClick={onExpand} aria-label="Open now playing">
              <Img src={t.cover} trackId={t.id} alt="" className="pb-art" />
            </button>
            <div className="pb-text">
              <span className="pb-name">
                {st.smart && st.smartIds.includes(t.id) ? (
                  <span className="smart-pick" title="Recommended by Smart Shuffle">
                    <Icon name="sparkle" size={12} />
                  </span>
                ) : null}
                {t.name}
              </span>
              <span className="pb-sub">
                <Artists track={t} />
              </span>
            </div>
            <LikeButton id={t.id} />
          </>
        ) : null}
      </div>
      <div className="pb-center">
        <Controls />
        <Progress />
        {st.error ? <div className="pb-error">{st.error}</div> : st.castDevice ? <div className="pb-cast">Playing on {st.castDevice}</div> : null}
      </div>
      <div className="pb-right">
        <button className="icon-btn" aria-label="Queue" onClick={onQueue}>
          <Icon name="queue" size={18} />
        </button>
        <CastButton />
        <button className="icon-btn" aria-label={st.volume ? 'Mute' : 'Unmute'} onClick={() => player.setVolume(st.volume ? 0 : 0.8)}>
          <Icon name={st.volume ? 'volume' : 'volumeOff'} size={18} />
        </button>
        <input
          type="range"
          className="range volume"
          min={0}
          max={1}
          step={0.01}
          value={st.volume}
          aria-label="Volume"
          style={{ '--pct': `${st.volume * 100}%` } as React.CSSProperties}
          onChange={(e) => player.setVolume(Number(e.target.value))}
        />
      </div>
      {/* Mobile mini player */}
      {t ? (
        <div className="mini" onClick={onExpand}>
          <Img src={t.cover} trackId={t.id} alt="" className="mini-art" />
          <span className="mini-text">
            <span className="mini-name">{t.name}</span>
            <span className="mini-sub">{st.castDevice ? `Casting to ${st.castDevice}` : t.artists.map((a) => a.name).join(', ')}</span>
          </span>
          <LikeButton id={t.id} size={22} />
          <button
            className="icon-btn"
            aria-label={st.playing ? 'Pause' : 'Play'}
            onClick={(e) => {
              e.stopPropagation();
              player.toggle();
            }}
          >
            {st.loading ? <span className="spinner small" /> : <Icon name={st.playing ? 'pause' : 'play'} size={24} />}
          </button>
          <Progress compact />
        </div>
      ) : null}
    </footer>
  );
}

function NowPlaying({ onClose, onQueue }: { onClose: () => void; onQueue: () => void }) {
  const st = usePlayer();
  const t = st.queue[st.index];
  const navigate = useNavigate();
  if (!t) return null;
  return (
    <div className="nowplaying" role="dialog" aria-label="Now playing">
      <div className="np-head">
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="down" size={26} />
        </button>
        <span className="np-context">{st.context ? st.context.name : 'Reddify'}</span>
        <button className="icon-btn" aria-label="Queue" onClick={() => (onClose(), onQueue())}>
          <Icon name="queue" size={22} />
        </button>
      </div>
      <Img src={t.cover?.replace('00001e02', '0000b273') ?? null} trackId={t.id} alt="" className="np-art" />
      <div className="np-title">
        <div>
          <div className="np-name" onClick={() => t.album && (onClose(), navigate(`/album/${t.album.id}`))}>
            {t.name}
          </div>
          <div className="np-artist" onClick={onClose}>
            <Artists track={t} />
          </div>
        </div>
        <LikeButton id={t.id} size={26} />
      </div>
      <Progress />
      <Controls />
      {st.error ? <div className="pb-error">{st.error}</div> : null}
      <div className="np-foot">
        <CastButton />
        <span className="muted small">
          {st.castDevice
            ? `Playing on ${st.castDevice}`
            : st.smart && st.smartIds.includes(t.id)
              ? 'Recommended by Smart Shuffle'
              : t.cached
                ? 'From your library'
                : ''}
        </span>
      </div>
    </div>
  );
}

export function Layout() {
  const [queueOpen, setQueueOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();
  useEffect(() => {
    void likes.load();
  }, []);
  useEffect(() => {
    document.querySelector('.main-scroll')?.scrollTo({ top: 0 });
    setExpanded(false);
  }, [location.pathname]);
  // Space toggles playback (outside inputs).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.code === 'Space' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
        e.preventDefault();
        player.toggle();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div className={`app ${queueOpen ? 'with-queue' : ''}`}>
      <Sidebar />
      <main className="main side-panel">
        <div className="main-scroll">
          <TopBar />
          <Outlet />
        </div>
      </main>
      {queueOpen ? <QueuePanel onClose={() => setQueueOpen(false)} /> : null}
      <PlayerBar onQueue={() => setQueueOpen((q) => !q)} onExpand={() => setExpanded(true)} />
      <nav className="mobile-nav" aria-label="Main">
        <NavLink to="/" end>
          {({ isActive }) => (
            <>
              <Icon name={isActive ? 'homeFill' : 'home'} /> <span>Home</span>
            </>
          )}
        </NavLink>
        <NavLink to="/search">
          {({ isActive }) => (
            <>
              <Icon name={isActive ? 'searchFill' : 'search'} /> <span>Search</span>
            </>
          )}
        </NavLink>
        <NavLink to="/collection">
          {({ isActive }) => (
            <>
              <Icon name={isActive ? 'libraryFill' : 'library'} /> <span>Your Library</span>
            </>
          )}
        </NavLink>
      </nav>
      {expanded ? <NowPlaying onClose={() => setExpanded(false)} onQueue={() => setQueueOpen(true)} /> : null}
      <Toasts />
    </div>
  );
}
