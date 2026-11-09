import type { AdminSettings, ArtistRef, AudioSource, Card, CoverRef, InstanceMode, MyPlaylist, Role, Track } from '../../../shared/api.js';
import type { DB } from './db.js';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  pw_hash: string | null;
  must_change_pw: number;
  totp_secret: Buffer | null;
  totp_last_step: number | null;
  oidc_sub: string | null;
  disabled: number;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  last_seen: number | null;
}

export interface SessionRow {
  id_hash: Buffer;
  user_id: number;
  kind: 'web' | 'app';
  label: string;
  csrf: string;
  created_at: number;
  last_seen: number;
  expires_at: number;
}

export interface OpRow {
  name: string;
  hash: string;
  variables: string;
  updated_at: number;
}

export interface FileRow {
  track_id: string;
  status: 'ready' | 'failed';
  path: string | null;
  size: number | null;
  mime: string | null;
  source_id: string | null;
  /** Which connection delivered the file ('youtube' | 'spotify'). */
  source: 'youtube' | 'spotify';
  match_score: number | null;
  error: string | null;
  has_cover: number;
  created_at: number;
  last_played: number | null;
  play_count: number;
}

interface TrackRow {
  id: string;
  name: string;
  artists: string;
  album_id: string | null;
  album_name: string | null;
  cover: string | null;
  duration_ms: number;
  explicit: number;
  updated_at: number;
}

interface PlaylistRow {
  id: number;
  user_id: number;
  name: string;
  description: string;
  created_at: number;
  updated_at: number;
  count: number;
  duration: number;
}

/**
 * Which library files a request may see: one user's own `library_tracks` entries, or every file (admins). The audio is
 * shared on disk (one copy per track for everyone), but the listing is per user: nobody may browse what the others
 * have.
 */
export type LibraryScope = number | 'all';

/** The library scope of a signed-in user: admins see the whole shared library, everyone else only their own songs. */
export function libraryScope(user: { id: number; role: Role }): LibraryScope {
  return user.role === 'admin' ? 'all' : user.id;
}

function rowToTrack(r: TrackRow, cached: boolean): Track {
  let artists: ArtistRef[] = [];
  try {
    artists = JSON.parse(r.artists) as ArtistRef[];
  } catch {
    /* keep empty */
  }
  return {
    id: r.id,
    name: r.name,
    artists,
    album: r.album_id && r.album_name ? { id: r.album_id, name: r.album_name } : null,
    cover: r.cover,
    durationMs: r.duration_ms,
    explicit: r.explicit === 1,
    playable: true,
    cached,
  };
}

/** Builds an FTS5 query that matches every word as a prefix ("tark adim" → "tark"* "adim"*). */
export function ftsQuery(q: string): string | null {
  const words = q
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"*`).join(' ');
}

export class Repo {
  constructor(readonly db: DB) {}

  /* ------------------------------------------------------------------ users */

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  userById(id: number): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  userByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  userBySub(sub: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE oidc_sub = ?').get(sub) as UserRow | undefined;
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[];
  }

  createUser(u: { username: string; displayName: string; role: Role; pwHash?: string | null; mustChange?: boolean; oidcSub?: string | null }): UserRow {
    const info = this.db
      .prepare(
        'INSERT INTO users (username, display_name, role, pw_hash, must_change_pw, oidc_sub, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(u.username, u.displayName, u.role, u.pwHash ?? null, u.mustChange ? 1 : 0, u.oidcSub ?? null, Date.now());
    return this.userById(Number(info.lastInsertRowid))!;
  }

  updateUser(id: number, patch: Partial<Omit<UserRow, 'id'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const allowed = new Set([
      'username', 'display_name', 'role', 'pw_hash', 'must_change_pw', 'totp_secret', 'totp_last_step', 'oidc_sub',
      'disabled', 'failed_logins', 'locked_until', 'last_seen',
    ]);
    for (const k of keys) if (!allowed.has(k)) throw new Error(`bad column ${k}`);
    const sql = `UPDATE users SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run({ ...patch, id });
  }

  deleteUser(id: number): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  countAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  /* --------------------------------------------------------------- sessions */

  insertSession(s: SessionRow): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id_hash, user_id, kind, label, csrf, created_at, last_seen, expires_at) VALUES (@id_hash,@user_id,@kind,@label,@csrf,@created_at,@last_seen,@expires_at)',
      )
      .run(s);
  }

  session(idHash: Buffer): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as SessionRow | undefined;
  }

  touchSession(idHash: Buffer, now: number): void {
    this.db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, idHash);
  }

  deleteSession(idHash: Buffer): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
  }

  deleteUserSessions(userId: number, except?: Buffer): void {
    if (except) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, except);
    else this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  userSessions(userId: number): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId) as SessionRow[];
  }

  pruneSessions(now: number, idleMs: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now, now - idleMs);
  }

  /* --------------------------------------------------------------- settings */

  setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  adminSettings(): AdminSettings {
    const mode = this.setting('instance_mode') === 'shared' ? 'shared' : 'per-user';
    const shared = Number(this.setting('shared_instance') ?? '1');
    const source = this.setting('audio_source');
    const audioSource: AudioSource =
      source === 'spotify' || source === 'youtube-preferred' || source === 'spotify-preferred' ? source : 'youtube';
    return {
      instanceMode: mode as InstanceMode,
      sharedInstance: Number.isInteger(shared) && shared > 0 ? shared : 1,
      audioSource,
    };
  }

  /* -------------------------------------------------------------------- ops */

  op(name: string): OpRow | undefined {
    return this.db.prepare('SELECT * FROM ops WHERE name = ?').get(name) as OpRow | undefined;
  }

  ops(): OpRow[] {
    return this.db.prepare('SELECT * FROM ops ORDER BY name').all() as OpRow[];
  }

  saveOp(name: string, hash: string, variables: unknown): void {
    this.db
      .prepare(
        'INSERT INTO ops (name, hash, variables, updated_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, variables = excluded.variables, updated_at = excluded.updated_at',
      )
      .run(name, hash, JSON.stringify(variables ?? {}), Date.now());
  }

  forgetOp(name: string): void {
    this.db.prepare('DELETE FROM ops WHERE name = ?').run(name);
  }

  /* ----------------------------------------------------------------- tracks */

  upsertTracks(tracks: Track[]): void {
    const st = this.db.prepare(
      `INSERT INTO tracks (id, name, artists, album_id, album_name, cover, duration_ms, explicit, updated_at)
       VALUES (@id,@name,@artists,@album_id,@album_name,@cover,@duration_ms,@explicit,@updated_at)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, artists = excluded.artists,
         album_id = COALESCE(excluded.album_id, tracks.album_id), album_name = COALESCE(excluded.album_name, tracks.album_name),
         cover = COALESCE(excluded.cover, tracks.cover), duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE tracks.duration_ms END,
         explicit = excluded.explicit, updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const t of tracks) {
        st.run({
          id: t.id,
          name: t.name,
          artists: JSON.stringify(t.artists),
          album_id: t.album?.id ?? null,
          album_name: t.album?.name ?? null,
          cover: t.cover,
          duration_ms: t.durationMs,
          explicit: t.explicit ? 1 : 0,
          updated_at: now,
        });
      }
    })();
  }

  track(id: string, scope: LibraryScope = 'all'): Track | undefined {
    const r = this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined;
    if (!r) return undefined;
    const ready = this.file(id)?.status === 'ready' && (scope === 'all' || this.inLibrary(scope, id));
    return rowToTrack(r, ready);
  }

  /** Whether the track is in that user's own library (a `library_tracks` entry; the file must still be complete). */
  private inLibrary(userId: number, trackId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM library_tracks lt JOIN files f ON f.track_id = lt.track_id
           WHERE lt.user_id = ? AND lt.track_id = ? AND f.status = 'ready'`,
        )
        .get(userId, trackId) !== undefined
    );
  }

  /** Adds the track to the user's library listing (idempotent): a user's own play is what puts a song in their list. */
  claimLibrary(userId: number, trackId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO library_tracks (user_id, track_id, added_at) VALUES (?,?,?)').run(userId, trackId, Date.now());
  }

  /** Marks which of the given tracks are in the caller's library (mutates and returns them). */
  markCached<T extends Track>(tracks: T[], scope: LibraryScope = 'all'): T[] {
    if (!tracks.length) return tracks;
    const ids = tracks.map((t) => t.id);
    const inList = ids.map(() => '?').join(',');
    const rows =
      scope === 'all'
        ? (this.db.prepare(`SELECT track_id FROM files WHERE status = 'ready' AND track_id IN (${inList})`).all(...ids) as {
            track_id: string;
          }[])
        : (this.db
            .prepare(
              `SELECT lt.track_id FROM library_tracks lt JOIN files f ON f.track_id = lt.track_id AND f.status = 'ready'
               WHERE lt.user_id = ? AND lt.track_id IN (${inList})`,
            )
            .all(scope, ...ids) as { track_id: string }[]);
    const ready = new Set(rows.map((r) => r.track_id));
    for (const t of tracks) t.cached = ready.has(t.id);
    return tracks;
  }

  /* ------------------------------------------------------------------ files */

  file(trackId: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE track_id = ?').get(trackId) as FileRow | undefined;
  }

  fileReady(f: {
    trackId: string;
    path: string;
    size: number;
    mime: string;
    sourceId: string;
    source: 'youtube' | 'spotify';
    score: number;
    hasCover: boolean;
  }): void {
    const t = this.db.prepare('SELECT rowid, * FROM tracks WHERE id = ?').get(f.trackId) as (TrackRow & { rowid: number }) | undefined;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO files (track_id, status, path, size, mime, source_id, source, match_score, error, has_cover, created_at)
           VALUES (?, 'ready', ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(track_id) DO UPDATE SET status = 'ready', path = excluded.path, size = excluded.size, mime = excluded.mime,
             source_id = excluded.source_id, source = excluded.source, match_score = excluded.match_score, error = NULL,
             has_cover = excluded.has_cover, created_at = excluded.created_at`,
        )
        .run(f.trackId, f.path, f.size, f.mime, f.sourceId, f.source, f.score, f.hasCover ? 1 : 0, Date.now());
      if (t) {
        this.db.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(t.rowid);
        const artists = (JSON.parse(t.artists) as ArtistRef[]).map((a) => a.name).join(' ');
        this.db.prepare('INSERT INTO tracks_fts (rowid, name, artists, album) VALUES (?,?,?,?)').run(t.rowid, t.name, artists, t.album_name ?? '');
      }
    })();
  }

  /** Records that a track's cover was saved after all (the audio is published first, the cover follows). */
  markCover(trackId: string, has: boolean): void {
    this.db.prepare('UPDATE files SET has_cover = ? WHERE track_id = ?').run(has ? 1 : 0, trackId);
  }

  fileFailed(trackId: string, error: string): void {
    this.db
      .prepare(
        `INSERT INTO files (track_id, status, error, created_at) VALUES (?, 'failed', ?, ?)
         ON CONFLICT(track_id) DO UPDATE SET status = 'failed', error = excluded.error, created_at = excluded.created_at
         WHERE files.status != 'ready'`,
      )
      .run(trackId, error.slice(0, 300), Date.now());
  }

  removeFile(trackId: string): void {
    const t = this.db.prepare('SELECT rowid FROM tracks WHERE id = ?').get(trackId) as { rowid: number } | undefined;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE track_id = ?').run(trackId);
      if (t) this.db.prepare('DELETE FROM tracks_fts WHERE rowid = ?').run(t.rowid);
    })();
  }

  storage(scope: LibraryScope = 'all'): { tracks: number; bytes: number; failed: number; bySource: { youtube: number; spotify: number } } {
    const own = scope === 'all' ? '' : ' AND EXISTS (SELECT 1 FROM library_tracks lt WHERE lt.track_id = files.track_id AND lt.user_id = ?)';
    const args = scope === 'all' ? [] : [scope];
    const r = this.db
      .prepare(
        `SELECT SUM(status = 'ready') AS tracks, COALESCE(SUM(CASE WHEN status = 'ready' THEN size END), 0) AS bytes, SUM(status = 'failed') AS failed FROM files WHERE 1=1${own}`,
      )
      .get(...args) as { tracks: number | null; bytes: number; failed: number | null };
    const per = this.db
      .prepare(`SELECT source, COUNT(*) AS n FROM files WHERE status = 'ready'${own} GROUP BY source`)
      .all(...args) as { source: string; n: number }[];
    const bySource = { youtube: 0, spotify: 0 };
    for (const row of per) if (row.source === 'spotify') bySource.spotify = row.n;
    for (const row of per) if (row.source !== 'spotify') bySource.youtube += row.n;
    return { tracks: r.tracks ?? 0, bytes: r.bytes, failed: r.failed ?? 0, bySource };
  }

  /** Library tracks (audio present), newest first, optionally filtered by a full-text query. */
  cachedTracks(opts: { q?: string; limit: number; offset: number; scope?: LibraryScope }): { tracks: Track[]; total: number } {
    const scope = opts.scope ?? 'all';
    const fq = opts.q ? ftsQuery(opts.q) : null;
    if (opts.q && !fq) return { tracks: [], total: 0 };
    const where = fq ? 'AND t.rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH @fq)' : '';
    const from = `FROM files f JOIN tracks t ON t.id = f.track_id${
      scope === 'all' ? '' : ' JOIN library_tracks lt ON lt.track_id = f.track_id AND lt.user_id = @scope'
    }`;
    const params: Record<string, unknown> = { fq, limit: opts.limit, offset: opts.offset };
    if (scope !== 'all') params.scope = scope;
    const rows = this.db
      .prepare(
        `SELECT t.* ${from} WHERE f.status = 'ready' ${where}
         ORDER BY COALESCE(f.last_played, f.created_at) DESC LIMIT @limit OFFSET @offset`,
      )
      .all(params) as TrackRow[];
    const countParams: Record<string, unknown> = { fq };
    if (scope !== 'all') countParams.scope = scope;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n ${from} WHERE f.status = 'ready' ${where}`).get(countParams) as {
        n: number;
      }
    ).n;
    return { tracks: rows.map((r) => rowToTrack(r, true)), total };
  }

  /* ------------------------------------------------------------ plays/likes */

  recordPlay(userId: number, trackId: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO plays (user_id, track_id, played_at) VALUES (?,?,?)').run(userId, trackId, now);
      this.db.prepare('UPDATE files SET last_played = ?, play_count = play_count + 1 WHERE track_id = ?').run(now, trackId);
      // Keep the last 500 plays per user.
      this.db
        .prepare(
          'DELETE FROM plays WHERE user_id = ? AND played_at < (SELECT played_at FROM plays WHERE user_id = ? ORDER BY played_at DESC LIMIT 1 OFFSET 499)',
        )
        .run(userId, userId);
    })();
  }

  recentTracks(userId: number, limit: number, scope: LibraryScope = 'all'): Track[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, MAX(p.played_at) AS lp FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.user_id = ?
         GROUP BY t.id ORDER BY lp DESC LIMIT ?`,
      )
      .all(userId, limit) as TrackRow[];
    return this.markCached(rows.map((r) => rowToTrack(r, false)), scope);
  }

  like(userId: number, trackId: string, on: boolean): void {
    if (on) this.db.prepare('INSERT OR IGNORE INTO likes (user_id, track_id, created_at) VALUES (?,?,?)').run(userId, trackId, Date.now());
    else this.db.prepare('DELETE FROM likes WHERE user_id = ? AND track_id = ?').run(userId, trackId);
  }

  likedIds(userId: number): string[] {
    return (this.db.prepare('SELECT track_id FROM likes WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { track_id: string }[]).map(
      (r) => r.track_id,
    );
  }

  likedTracks(userId: number, scope: LibraryScope = 'all'): Track[] {
    const rows = this.db
      .prepare('SELECT t.* FROM likes l JOIN tracks t ON t.id = l.track_id WHERE l.user_id = ? ORDER BY l.created_at DESC')
      .all(userId) as TrackRow[];
    return this.markCached(rows.map((r) => rowToTrack(r, false)), scope);
  }

  /* ---------------------------------------------------- hidden library items */

  /** Spotify library items the user removed from Your Library in Reddify (newest first). Spotify is not changed. */
  hiddenLibrary(userId: number): Card[] {
    const rows = this.db
      .prepare('SELECT kind, item_id, name, subtitle, image FROM library_hidden WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as { kind: Card['kind']; item_id: string; name: string; subtitle: string; image: string | null }[];
    return rows.map((r) => ({ kind: r.kind, id: r.item_id, name: r.name, subtitle: r.subtitle, image: r.image }));
  }

  hideLibraryItem(userId: number, c: Card): void {
    this.db
      .prepare('INSERT OR REPLACE INTO library_hidden (user_id, kind, item_id, name, subtitle, image, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(userId, c.kind, c.id, c.name.slice(0, 300), c.subtitle.slice(0, 300), c.image, Date.now());
  }

  /** Returns false when the item was not hidden. */
  unhideLibraryItem(userId: number, kind: string, id: string): boolean {
    return this.db.prepare('DELETE FROM library_hidden WHERE user_id = ? AND kind = ? AND item_id = ?').run(userId, kind, id).changes > 0;
  }

  /* -------------------------------------------------------------- playlists */

  static readonly MAX_PLAYLISTS = 1000;
  static readonly MAX_PLAYLIST_TRACKS = 10_000;

  private playlistRow(r: PlaylistRow): MyPlaylist {
    const covers = this.db
      .prepare(
        `SELECT t.id, t.cover, COALESCE(t.album_id, t.id) AS a, MIN(pt.pos) AS p FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ? GROUP BY a ORDER BY p LIMIT 4`,
      )
      .all(r.id) as { id: string; cover: string | null }[];
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      count: r.count,
      durationMs: r.duration,
      covers: covers.map((c): CoverRef => ({ url: c.cover, trackId: c.id })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private static readonly PLAYLIST_SELECT = `SELECT p.*, COUNT(pt.track_id) AS count, COALESCE(SUM(t.duration_ms), 0) AS duration
    FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id LEFT JOIN tracks t ON t.id = pt.track_id`;

  playlists(userId: number): MyPlaylist[] {
    const rows = this.db.prepare(`${Repo.PLAYLIST_SELECT} WHERE p.user_id = ? GROUP BY p.id ORDER BY p.updated_at DESC`).all(userId) as PlaylistRow[];
    return rows.map((r) => this.playlistRow(r));
  }

  /** The playlist if it exists AND belongs to `userId` (no one else may see or change it). */
  playlist(userId: number, id: number): MyPlaylist | undefined {
    const r = this.db.prepare(`${Repo.PLAYLIST_SELECT} WHERE p.id = ? AND p.user_id = ? GROUP BY p.id`).get(id, userId) as PlaylistRow | undefined;
    return r ? this.playlistRow(r) : undefined;
  }

  countPlaylists(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE user_id = ?').get(userId) as { n: number }).n;
  }

  createPlaylist(userId: number, name: string, description: string): number {
    const now = Date.now();
    return Number(
      this.db.prepare('INSERT INTO playlists (user_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)').run(userId, name, description, now, now)
        .lastInsertRowid,
    );
  }

  /** "My Playlist #n", like Spotify: the first number not used by one of the user's playlists. */
  nextPlaylistName(userId: number): string {
    const names = new Set((this.db.prepare('SELECT name FROM playlists WHERE user_id = ?').all(userId) as { name: string }[]).map((r) => r.name));
    let n = names.size + 1;
    for (let i = 1; i <= names.size + 1; i++) {
      if (!names.has(`My Playlist #${i}`)) {
        n = i;
        break;
      }
    }
    return `My Playlist #${n}`;
  }

  updatePlaylist(id: number, patch: { name?: string; description?: string }): void {
    const sets: string[] = ['updated_at = @now'];
    if (patch.name !== undefined) sets.push('name = @name');
    if (patch.description !== undefined) sets.push('description = @description');
    this.db.prepare(`UPDATE playlists SET ${sets.join(', ')} WHERE id = @id`).run({ id, now: Date.now(), name: patch.name, description: patch.description });
  }

  deletePlaylist(id: number): void {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  playlistTracks(id: number, scope: LibraryScope = 'all'): Track[] {
    const rows = this.db
      .prepare('SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.pos')
      .all(id) as TrackRow[];
    return this.markCached(rows.map((r) => rowToTrack(r, false)), scope);
  }

  /** Appends tracks (known to the `tracks` table) that are not in the playlist yet; returns how many were added. */
  addToPlaylist(id: number, trackIds: string[]): number {
    return this.db.transaction(() => {
      let pos = (this.db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?').get(id) as { n: number }).n;
      const ins = this.db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, pos, added_at) VALUES (?,?,?,?)');
      const now = Date.now();
      let added = 0;
      for (const t of trackIds) {
        if (pos >= Repo.MAX_PLAYLIST_TRACKS) break;
        if (ins.run(id, t, pos, now).changes) {
          pos++;
          added++;
        }
      }
      this.updatePlaylist(id, {});
      return added;
    })();
  }

  removeFromPlaylist(id: number, trackId: string): boolean {
    return this.db.transaction(() => {
      const r = this.db.prepare('SELECT pos FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(id, trackId) as { pos: number } | undefined;
      if (!r) return false;
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(id, trackId);
      this.db.prepare('UPDATE playlist_tracks SET pos = pos - 1 WHERE playlist_id = ? AND pos > ?').run(id, r.pos);
      this.updatePlaylist(id, {});
      return true;
    })();
  }

  /** Moves one track to position `to` (0-based, clamped); the others shift. */
  movePlaylistTrack(id: number, trackId: string, to: number): boolean {
    return this.db.transaction(() => {
      const r = this.db.prepare('SELECT pos FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(id, trackId) as { pos: number } | undefined;
      if (!r) return false;
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?').get(id) as { n: number }).n;
      const dest = Math.max(0, Math.min(n - 1, to));
      if (dest > r.pos) this.db.prepare('UPDATE playlist_tracks SET pos = pos - 1 WHERE playlist_id = ? AND pos > ? AND pos <= ?').run(id, r.pos, dest);
      else if (dest < r.pos) this.db.prepare('UPDATE playlist_tracks SET pos = pos + 1 WHERE playlist_id = ? AND pos >= ? AND pos < ?').run(id, dest, r.pos);
      this.db.prepare('UPDATE playlist_tracks SET pos = ? WHERE playlist_id = ? AND track_id = ?').run(dest, id, trackId);
      this.updatePlaylist(id, {});
      return true;
    })();
  }

  /** Which of the user's playlists contain the track (for the "Add to playlist" menu's check marks). */
  playlistsWith(userId: number, trackId: string): number[] {
    return (
      this.db
        .prepare('SELECT p.id FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id WHERE p.user_id = ? AND pt.track_id = ?')
        .all(userId, trackId) as { id: number }[]
    ).map((r) => r.id);
  }

  /* ------------------------------------------------------------------ audit */

  audit(event: string, ip: string | null, userId: number | null = null): void {
    this.db.prepare('INSERT INTO audit (ts, user_id, event, ip) VALUES (?,?,?,?)').run(Date.now(), userId, event, ip);
    this.db.prepare('DELETE FROM audit WHERE ts < ?').run(Date.now() - 180 * 86_400_000);
  }
}
