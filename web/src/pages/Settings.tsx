import QRCode from 'qrcode';
import { type FormEvent, useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import type {
  AdminSettings,
  AdminUser,
  AudioSource,
  CaptureSelftest,
  CaptureStatus,
  SessionInfo,
  SpotifyStatus,
  StorageStats,
} from '../../../shared/api';
import { api } from '../api/client';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading, Spinner, useLoad } from '../components/ui';
import { VncViewer } from '../components/VncViewer';
import { useAuth } from '../state';

function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : 'never';
}

export function SettingsPage() {
  const { tab = 'account' } = useParams();
  const { me } = useAuth();
  return (
    <div className="page settings">
      <h1 className="page-title">Settings</h1>
      <div className="chips">
        <NavLink to="/settings" end className={({ isActive }) => `chip ${isActive ? 'on' : ''}`}>
          Account
        </NavLink>
        <NavLink to="/settings/spotify" className={({ isActive }) => `chip ${isActive ? 'on' : ''}`}>
          Spotify connection
        </NavLink>
        {me?.role === 'admin' ? (
          <NavLink to="/settings/admin" className={({ isActive }) => `chip ${isActive ? 'on' : ''}`}>
            Admin
          </NavLink>
        ) : null}
      </div>
      {tab === 'spotify' ? <SpotifySettings /> : tab === 'admin' && me?.role === 'admin' ? <AdminSettingsPanel /> : <AccountSettings />}
    </div>
  );
}

/* ------------------------------------------------------------------- account */

function AccountSettings() {
  const { me, refresh } = useAuth();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [totp, setTotp] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const sessions = useLoad(() => api.sessions(), []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed.');
    }
  };

  return (
    <div className="settings-body">
      {msg ? <p className="form-ok">{msg}</p> : null}
      {err ? <p className="form-error">{err}</p> : null}
      <section className="panel">
        <h2>Android app</h2>
        <p className="muted small">Background playback, songs downloaded to the phone for offline play, and casting. Sign in with this server's address.</p>
        <p>
          <a className="btn" href="/reddify.apk" download>
            <Icon name="download" size={16} /> Download Reddify for Android
          </a>
        </p>
      </section>
      <section className="panel">
        <h2>Profile</h2>
        <p>
          Signed in as <b>{me?.displayName}</b> ({me?.username}) — {me?.role}
          {me?.oidc ? ' • via authentik' : ''}
        </p>
      </section>
      {me?.local ? (
        <section className="panel">
          <h2>Password</h2>
          <form
            className="form row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(() => api.changePassword(cur, next), 'Password changed. Other sessions were signed out.').then(() => (setCur(''), setNext('')));
            }}
          >
            <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
            <input type="password" placeholder="New password (12+)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required />
            <button className="btn">Change</button>
          </form>
        </section>
      ) : null}
      {me?.local ? (
        <section className="panel">
          <h2>Two-factor authentication</h2>
          {me.totp ? (
            <form
              className="form row"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.totpDisable(code), 'Two-factor authentication is off.').then(() => setCode(''));
              }}
            >
              <span className="ok-line">
                <Icon name="check" size={18} /> On
              </span>
              <input placeholder="Current code to turn it off" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required />
              <button className="btn">Turn off</button>
            </form>
          ) : totp ? (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.totpConfirm(code), 'Two-factor authentication is on.').then(() => (setTotp(null), setCode('')));
              }}
            >
              <img src={totp.qr} alt="QR code for your authenticator app" className="qr" />
              <p className="muted small">Or enter this key: <code>{totp.secret}</code></p>
              <div className="row">
                <input placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
                <button className="btn btn-accent">Turn on</button>
              </div>
            </form>
          ) : (
            <button
              className="btn"
              onClick={() =>
                void api.totpSetup().then(async (r) => setTotp({ secret: r.secret, qr: await QRCode.toDataURL(r.url, { margin: 1, width: 200 }) }))
              }
            >
              Set up an authenticator app
            </button>
          )}
        </section>
      ) : null}
      <section className="panel">
        <h2>Signed-in devices</h2>
        {sessions.data ? (
          <div className="rows">
            {sessions.data.map((s: SessionInfo) => (
              <div key={s.id} className="row-item">
                <span>
                  <b>{s.label}</b> {s.current ? <span className="pill">this device</span> : null}
                  <br />
                  <span className="muted small">last used {fmtDate(s.lastSeen)}</span>
                </span>
                {!s.current ? (
                  <button className="btn small" onClick={() => void api.revokeSession(s.id).then(sessions.reload)}>
                    Sign out
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <Loading />
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- spotify */

function SpotifySettings() {
  const [st, setSt] = useState<SpotifyStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showScreen, setShowScreen] = useState(false);
  const [cookie, setCookie] = useState('');

  const load = () =>
    api
      .spotifyStatus()
      .then(setSt)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Failed'));
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, []);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  if (!st) return err ? <ErrorBox error={err} /> : <Loading />;
  return (
    <div className="settings-body">
      {err ? <p className="form-error">{err}</p> : null}
      <section className="panel">
        <h2>Status</h2>
        <div className="status-grid">
          <span>Browser</span>
          <b className={st.browser === 'running' ? 'good' : 'warn'}>{st.browser}</b>
          <span>Spotify account</span>
          <b className={st.loggedIn ? 'good' : 'warn'}>{st.loggedIn ? 'logged in' : 'not logged in (anonymous browsing still works)'}</b>
          <span>Instance</span>
          <b>
            #{st.instance} ({st.mode === 'shared' ? 'shared by everyone' : 'your own'})
          </b>
          <span>Learned queries</span>
          <b>{st.learned.length ? st.learned.join(', ') : 'none yet'}</b>
        </div>
        <p className="muted small">
          Reddify reads Spotify (search, home, playlists, recommendations) through a real Chromium that is logged in to your Spotify account.
          Logging in makes the home page and recommendations personal and shows your playlists.
        </p>
      </section>
      {st.canManage ? (
        <>
          <section className="panel">
            <h2>Log in to Spotify</h2>
            <div className="row wrap">
              <button className="btn btn-accent" disabled={!!busy} onClick={() => void act('login', async () => (await api.spotifyLogin(), setShowScreen(true)))}>
                {busy === 'login' ? <Spinner size={16} /> : null} Open the Spotify login
              </button>
              <button className="btn" onClick={() => setShowScreen((s) => !s)}>
                {showScreen ? 'Hide the browser screen' : 'Show the browser screen'}
              </button>
              {st.loggedIn ? (
                <button className="btn" disabled={!!busy} onClick={() => void act('logout', () => api.spotifyLogout())}>
                  Log out of Spotify
                </button>
              ) : null}
              <button className="btn" disabled={!!busy} onClick={() => void act('restart', () => api.spotifyRestart())}>
                Restart the browser
              </button>
            </div>
            <p className="muted small">The login page opens in Reddify's browser; type your Spotify login on the screen below. It closes by itself once you are in.</p>
            {showScreen ? <VncViewer viewOnly={false} className="spotify-screen" /> : null}
          </section>
          <section className="panel">
            <h2>Or paste your Spotify cookie</h2>
            <p className="muted small">
              In a browser where you are logged in to open.spotify.com: Developer tools → Application → Cookies → https://open.spotify.com → copy the
              value of <code>sp_dc</code>.
            </p>
            <form
              className="form row"
              onSubmit={(e) => {
                e.preventDefault();
                void act('cookie', () => api.spotifyCookie(cookie)).then(() => setCookie(''));
              }}
            >
              <input type="password" placeholder="sp_dc value" value={cookie} onChange={(e) => setCookie(e.target.value)} autoComplete="off" required />
              <button className="btn" disabled={!!busy}>
                Use this login
              </button>
            </form>
          </section>
        </>
      ) : (
        <section className="panel">
          <p>Your admin set Reddify to share one Spotify browser for everyone; only an admin can log it in or out.</p>
        </section>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- admin */

function AdminSettingsPanel() {
  const users = useLoad(() => api.users(), []);
  const settings = useLoad(() => api.adminSettings(), []);
  const storage = useLoad(() => api.storage(), []);
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'admin'>('user');
  const [secret, setSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { me } = useAuth();

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      users.reload();
      settings.reload();
      storage.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    }
  };

  const s: AdminSettings | null = settings.data;
  const st: StorageStats | null = storage.data;
  return (
    <div className="settings-body">
      {err ? <p className="form-error">{err}</p> : null}
      {secret ? (
        <p className="form-ok">
          Temporary password (shown once): <code>{secret}</code> — the user picks their own at first login.
        </p>
      ) : null}
      <section className="panel">
        <h2>Spotify browsers</h2>
        {s ? (
          <div className="form">
            <label className="radio">
              <input type="radio" checked={s.instanceMode === 'per-user'} onChange={() => void run(() => api.saveAdminSettings({ ...s, instanceMode: 'per-user' }))} />
              Every user has their own Chromium (own Spotify login, personal recommendations)
            </label>
            <label className="radio">
              <input type="radio" checked={s.instanceMode === 'shared'} onChange={() => void run(() => api.saveAdminSettings({ ...s, instanceMode: 'shared' }))} />
              Everyone uses one Chromium (less memory, one Spotify account)
            </label>
            {s.instanceMode === 'shared' ? (
              <label>
                Shared browser
                <select value={s.sharedInstance} onChange={(e) => void run(() => api.saveAdminSettings({ ...s, sharedInstance: Number(e.target.value) }))}>
                  {(users.data ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      #{u.id} — {u.username}'s browser
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ) : (
          <Loading />
        )}
      </section>
      <section className="panel">
        <h2>Audio source</h2>
        {s ? (
          <div className="form">
            <label>
              Where the songs come from
              <select
                value={s.audioSource}
                onChange={(e) => void run(() => api.saveAdminSettings({ ...s, audioSource: e.target.value as AdminSettings['audioSource'] }))}
              >
                {AUDIO_SOURCE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">{AUDIO_SOURCE_OPTIONS.find((o) => o.value === s.audioSource)?.hint}</p>
            <p className="muted small">
              The first play of a song fetches it once and keeps the file in the shared library, so every later play — for everyone — comes from
              disk, whatever this setting says.
            </p>
          </div>
        ) : (
          <Loading />
        )}
      </section>
      <AudioEnginePanel />
      <section className="panel">
        <h2>Library storage</h2>
        {st ? (
          <p>
            {st.tracks} songs, {fmtBytes(st.bytes)} • {st.bySource.youtube} from YouTube Music, {st.bySource.spotify} from Spotify •{' '}
            {st.downloading} downloading • {st.failed} not found
          </p>
        ) : (
          <Loading />
        )}
      </section>
      <section className="panel">
        <h2>Users</h2>
        <form
          className="form row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.createUser(newName, newRole);
              setSecret(r.temporaryPassword);
              setNewName('');
            });
          }}
        >
          <input placeholder="New local username" value={newName} onChange={(e) => setNewName(e.target.value)} pattern="[A-Za-z0-9._-]{2,32}" required />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'user' | 'admin')}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button className="btn">Add user</button>
        </form>
        <p className="muted small">People who sign in with authentik get an account automatically (whoever authentik lets into the app).</p>
        <div className="rows">
          {(users.data ?? []).map((u: AdminUser) => (
            <div key={u.id} className={`row-item ${u.disabled ? 'dim' : ''}`}>
              <span>
                <b>{u.displayName}</b> <span className="muted">({u.username})</span> <span className="pill">{u.role}</span>
                {u.oidc ? <span className="pill">authentik</span> : null}
                {u.local ? <span className="pill">local</span> : null}
                {u.totp ? <span className="pill">2FA</span> : null}
                {u.disabled ? <span className="pill warn">disabled</span> : null}
                <br />
                <span className="muted small">
                  browser #{u.instance} • last seen {fmtDate(u.lastSeen)}
                </span>
              </span>
              {u.id !== me?.id ? (
                <span className="row-actions">
                  <button className="btn small" onClick={() => void run(() => api.updateUser(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }))}>
                    Make {u.role === 'admin' ? 'user' : 'admin'}
                  </button>
                  <button className="btn small" onClick={() => void run(() => api.updateUser(u.id, { disabled: !u.disabled }))}>
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                  {u.local ? (
                    <button className="btn small" onClick={() => void run(async () => setSecret((await api.resetPassword(u.id)).temporaryPassword))}>
                      Reset password
                    </button>
                  ) : null}
                  <button className="btn small" onClick={() => void run(() => api.stopBrowser(u.id))}>
                    Stop browser
                  </button>
                  <button
                    className="btn small danger"
                    onClick={() => {
                      if (window.confirm(`Delete ${u.username}? Their likes and history go too (the shared library stays).`)) void run(() => api.deleteUser(u.id));
                    }}
                  >
                    Delete
                  </button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------- spotify audio engine */

const AUDIO_SOURCE_OPTIONS: { value: AudioSource; label: string; hint: string }[] = [
  {
    value: 'youtube',
    label: 'YouTube Music only',
    hint: 'Every song is matched on YouTube Music, as before. Nothing is recorded from Spotify.',
  },
  {
    value: 'spotify',
    label: 'Spotify only',
    hint: 'Every song is recorded from the Spotify audio engine. A song it cannot record is reported as not found — it is never replaced by a YouTube copy.',
  },
  {
    value: 'youtube-preferred',
    label: 'YouTube Music first, Spotify as fallback',
    hint: 'YouTube Music is asked first; only a song it cannot match is recorded from Spotify.',
  },
  {
    value: 'spotify-preferred',
    label: 'Spotify first, YouTube Music as fallback',
    hint: 'Spotify is recorded first; when the engine is down or the song cannot be played there, YouTube Music is used instead.',
  },
];

/**
 * The admin's view of the Spotify audio engine: its own Chrome (with Widevine) playing Spotify's web player into a
 * virtual speaker that the server records. Nothing here touches the DRM — the browser decrypts, the sink is read.
 */
function AudioEnginePanel() {
  const [st, setSt] = useState<CaptureStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<CaptureSelftest | null>(null);
  const [screen, setScreen] = useState(false);
  const [cookie, setCookie] = useState('');

  const load = () =>
    api
      .captureStatus()
      .then(setSt)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Failed'));

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, []);

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  if (!st) return err ? <ErrorBox error={err} /> : <Loading />;
  return (
    <section className="panel">
      <h2>Spotify audio engine</h2>
      {err ? <p className="form-error">{err}</p> : null}
      {msg ? <p className="form-ok">{msg}</p> : null}
      {!st.configured ? (
        <p className="muted small">
          This deployment has no capture container (<code>CAPTURE_URL</code> is empty), so Spotify cannot be used as an audio source. Bring the
          stack up with <code>docker compose up -d</code> to get it.
        </p>
      ) : (
        <>
          <div className="status-grid">
            <span>Container</span>
            <b className={st.browser === 'running' ? 'good' : 'warn'}>{st.browser}</b>
            <span>Spotify account</span>
            <b className={st.loggedIn ? 'good' : 'warn'}>{st.loggedIn ? `${st.account ?? 'logged in'}` : 'not logged in'}</b>
            <span>Recording</span>
            <b>{st.current ? 'now' : 'idle'}</b>
            <span>Captured since start</span>
            <b>{st.captured}</b>
          </div>
          <p className="muted small">
            A separate Google Chrome (the only browser here with Widevine) plays the song in Spotify&apos;s own web player and the server records
            the output of a virtual speaker. Nothing is decrypted or re-signed: the browser plays, the sink is read. Recording is real time, so the
            first play of a Spotify-sourced song starts a few seconds in and fills up as it plays.
          </p>
          <div className="row wrap">
            <button className="btn" disabled={!!busy} onClick={() => void act('ensure', () => api.captureEnsure(), 'The engine is starting.')}>
              {busy === 'ensure' ? <Spinner size={16} /> : null} Start
            </button>
            <button className="btn" disabled={!!busy} onClick={() => void act('restart', () => api.captureRestart(), 'The engine restarted.')}>
              {busy === 'restart' ? <Spinner size={16} /> : null} Restart
            </button>
            <button
              className="btn btn-accent"
              disabled={!!busy}
              onClick={() =>
                void act('login', async () => {
                  await api.captureLogin();
                  setScreen(true);
                })
              }
            >
              {busy === 'login' ? <Spinner size={16} /> : null} Log in to Spotify
            </button>
            {st.loggedIn ? (
              <button className="btn" disabled={!!busy} onClick={() => void act('logout', () => api.captureLogout(), 'Logged out.')}>
                Log out
              </button>
            ) : null}
            <button className="btn" onClick={() => setScreen((v) => !v)}>
              {screen ? 'Hide the screen' : 'Show the screen'}
            </button>
            <button
              className="btn"
              disabled={!!busy}
              onClick={() =>
                void act(
                  'test',
                  async () => {
                    const r = await api.captureSelftest();
                    setTest(r);
                    if (!r.ok) throw new Error(r.error ?? 'The engine could not record its own test tone.');
                  },
                  'The engine recorded its test tone.',
                )
              }
            >
              {busy === 'test' ? <Spinner size={16} /> : null} Test the capture
            </button>
          </div>
          {test ? (
            <p className={test.ok ? 'form-ok' : 'form-error'}>
              {test.ok ? 'Self-test passed' : 'Self-test failed'}: {test.frames} frames of {test.expectedFrames}
              {test.trimmed ? ' (leading silence trimmed)' : ''}, peak {test.peakDb} dBFS, RMS {test.rmsDb} dBFS, {Math.round(test.bytes / 1024)} KB
              {test.codec ? ` ${test.codec}` : ''} · Widevine: {test.widevine.length ? test.widevine.join(', ') : 'not available'}
            </p>
          ) : null}
          {screen ? <VncViewer viewOnly={false} className="spotify-screen" endpoint="/api/admin/capture/vnc" credentials={api.captureVncCredentials} /> : null}
          <p className="muted small">
            Use a <b>separate Premium account</b> for the engine: Spotify plays one stream per account, so recording from your own account stops
            playback on your phone. A free account plays ads into the recording and is refused.
          </p>
          <form
            className="form row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void act('cookie', () => api.captureCookie(cookie), 'Cookie imported.').then(() => setCookie(''));
            }}
          >
            <input
              type="password"
              placeholder="Or paste the engine account's sp_dc cookie"
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              autoComplete="off"
            />
            <button className="btn" disabled={!!busy || cookie.length < 40}>
              Use this login
            </button>
          </form>
        </>
      )}
    </section>
  );
}
