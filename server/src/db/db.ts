import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/**
 * Schema migrations, applied in order and recorded in PRAGMA user_version. Never edit a shipped migration: append a
 * new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','user')),
    pw_hash TEXT,
    must_change_pw INTEGER NOT NULL DEFAULT 0,
    totp_secret BLOB,
    totp_last_step INTEGER,
    oidc_sub TEXT UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE TABLE sessions (
    id_hash BLOB PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('web','app')),
    label TEXT NOT NULL DEFAULT '',
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE ops (
    name TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    variables TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    artists TEXT NOT NULL,
    album_id TEXT,
    album_name TEXT,
    cover TEXT,
    duration_ms INTEGER NOT NULL,
    explicit INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE files (
    track_id TEXT PRIMARY KEY REFERENCES tracks(id),
    status TEXT NOT NULL CHECK (status IN ('ready','failed')),
    path TEXT,
    size INTEGER,
    mime TEXT,
    source_id TEXT,
    match_score REAL,
    error TEXT,
    has_cover INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_played INTEGER,
    play_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE plays (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX plays_user ON plays(user_id, played_at DESC);
  CREATE TABLE likes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );
  CREATE TABLE audit (
    ts INTEGER NOT NULL,
    user_id INTEGER,
    event TEXT NOT NULL,
    ip TEXT
  );
  CREATE VIRTUAL TABLE tracks_fts USING fts5(name, artists, album, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
  `,
  // 2: the users' own playlists (a track appears at most once per playlist; pos is 0-based and dense).
  `
  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_user ON playlists(user_id, updated_at DESC);
  CREATE TABLE playlist_tracks (
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES tracks(id),
    pos INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id)
  ) WITHOUT ROWID;
  CREATE INDEX playlist_tracks_pos ON playlist_tracks(playlist_id, pos);
  `,
  // 3: which connection delivered a library file ('youtube' | 'spotify'), for the admin's per-source counts.
  `ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'youtube';`,
  // 4: Spotify library items (playlists, albums, artists) a user removed from Your Library in Reddify only. The card is
  // kept so the item can be listed and restored while Spotify is unreachable. Nothing is changed on Spotify.
  `
  CREATE TABLE library_hidden (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('playlist','album','artist')),
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    image TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
  ) WITHOUT ROWID;
  `,
];

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'reddify.db'));
  return prepare(db);
}

export function openMemoryDb(): DB {
  return prepare(new Database(':memory:'));
}

function prepare(db: DB): DB {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('secure_delete = ON');
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
