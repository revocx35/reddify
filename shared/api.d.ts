/**
 * Reddify HTTP API contract (types only). Shared by the server (server/src), the web UI (web/src) and mirrored by
 * the Android client (revocx35/reddify_android core/.../Models.kt). Change this file first, then all three.
 */

export interface ArtistRef {
  id: string;
  name: string;
}

export interface AlbumRef {
  id: string;
  name: string;
}

/** One Spotify track as Reddify shows it. `id` is the Spotify track id (22 chars, base62). */
export interface Track {
  id: string;
  name: string;
  artists: ArtistRef[];
  album: AlbumRef | null;
  /** Cover art URL on Spotify's CDN (null when unknown); clients fall back to /api/cover/<id> when offline. */
  cover: string | null;
  durationMs: number;
  explicit: boolean;
  /** False when Spotify says the track cannot be played (region etc.); Reddify can still try to match it. */
  playable: boolean;
  /** True when the audio is already in Reddify's library (plays without Spotify/YouTube). */
  cached?: boolean;
}

export type CardKind = 'album' | 'artist' | 'playlist' | 'track';

/** A tile on the home screen, in search results, on an artist page. */
export interface Card {
  kind: CardKind;
  id: string;
  name: string;
  subtitle: string;
  image: string | null;
  /** Only for kind 'track'. */
  track?: Track;
}

export interface Section {
  title: string;
  items: Card[];
}

export interface HomeResponse {
  greeting: string;
  sections: Section[];
  /** True when Spotify could not be reached and the page was built from the local library only. */
  offline: boolean;
}

export interface SearchResponse {
  query: string;
  top: Card | null;
  tracks: Track[];
  artists: Card[];
  albums: Card[];
  playlists: Card[];
  offline: boolean;
}

export interface TrackPage {
  tracks: Track[];
  total: number;
  offset: number;
}

export interface AlbumResponse {
  album: { id: string; name: string; cover: string | null; artists: ArtistRef[]; year: string; type: string; label: string };
  tracks: Track[];
}

export interface ArtistResponse {
  artist: { id: string; name: string; image: string | null; header: string | null; monthlyListeners: number | null };
  topTracks: Track[];
  albums: Card[];
  singles: Card[];
  related: Card[];
}

export interface PlaylistResponse {
  playlist: { id: string; name: string; description: string; image: string | null; owner: string };
  tracks: Track[];
  total: number;
  offset: number;
}

export type FileStatus = 'none' | 'queued' | 'downloading' | 'ready' | 'failed';

/**
 * Where a track's audio comes from (admin setting). `spotify` records the decrypted audio of a real Spotify web player
 * running in a Chrome with Widevine (capture container); `youtube` matches the song on YouTube Music. The `-preferred`
 * variants try that source first and fall back to the other one when it cannot deliver the track.
 */
export type AudioSource = 'youtube' | 'spotify' | 'youtube-preferred' | 'spotify-preferred';

/** The Spotify audio engine (capture container): its own Chrome with Widevine and one virtual speaker. */
export interface CaptureStatus {
  /** False when this deployment has no capture container (CAPTURE_URL empty): only YouTube audio is possible. */
  configured: boolean;
  browser: 'running' | 'stopped' | 'unreachable';
  loggedIn: boolean;
  /** The Spotify account shown in the engine's own web player (null when unknown / logged out). */
  account: string | null;
  /** Tracks waiting for the engine, and the one it is recording now. */
  queued: number;
  current: string | null;
  /** Captures finished since the container started. */
  captured: number;
}

/**
 * Result of the capture container's selftest: it plays its own generated tone through the virtual speaker and records
 * it, which proves the whole path (sink → recorder → lossless encode) without touching Spotify.
 */
export interface CaptureSelftest {
  ok: boolean;
  /** Frames recorded and the frames the tone was supposed to produce. */
  frames: number;
  expectedFrames: number;
  /** True when the sink's leading silence was dropped (the file starts at the first audible sample). */
  trimmed: boolean;
  peakDb: number;
  rmsDb: number;
  bytes: number;
  /** What ffprobe says the written file is (e.g. 'flac'). */
  codec: string | null;
  /** Widevine robustness levels this Chrome offers; 'SW_SECURE_CRYPTO' is the L3 path Spotify streams over. */
  widevine: string[];
  error?: string;
}

/** POST /api/smart-shuffle: the tracks of what is playing (seeds + exclusions). */
export interface SmartShuffleRequest {
  /** Track ids of the playing list (1..500). Recommendations are seeded from a few of them and never repeat one. */
  trackIds: string[];
  /** How many recommendations to return (1..50, default 20). */
  count?: number;
}

/** Spotify's recommendations to mix into a shuffled queue ("Smart Shuffle"). */
export interface SmartShuffleResponse {
  tracks: Track[];
  /** true = Spotify was unreachable and these are random library tracks. */
  offline: boolean;
}

export interface PrepareResponse {
  id: string;
  status: FileStatus;
  error?: string;
}

export interface CastResponse {
  /** Absolute URL a Chromecast can fetch without cookies (signed, expires). */
  url: string;
  contentType: string;
  cover: string | null;
  track: Track;
}

export interface LibraryResponse {
  liked: number;
  downloaded: number;
  /** The Spotify account's own playlists, albums and artists (empty when the browser is not logged in), minus the
   * ones the user removed in Reddify. Read-only on Spotify. */
  playlists: Card[];
  /** Spotify library items removed from Your Library in Reddify only (Spotify keeps them); can be restored. */
  hidden: Card[];
  /** The user's own Reddify playlists (editable; stored on the Reddify server, work offline). */
  mine: MyPlaylist[];
}

/** One cover tile of a Reddify playlist: Spotify CDN URL, with the library's cached cover as fallback. */
export interface CoverRef {
  url: string | null;
  trackId: string;
}

/** A playlist the user made in Reddify (not on Spotify). Only its owner can see or change it. */
export interface MyPlaylist {
  id: number;
  name: string;
  description: string;
  count: number;
  durationMs: number;
  /** Up to 4 covers of different albums (the clients draw a 2x2 mosaic with 4, else the first). */
  covers: CoverRef[];
  createdAt: number;
  updatedAt: number;
}

export interface MyPlaylistResponse {
  playlist: MyPlaylist;
  tracks: Track[];
}

/** POST /api/playlists. `tracks` (Spotify track ids) are added in order, e.g. to copy a Spotify playlist. */
export interface CreatePlaylistRequest {
  name?: string;
  description?: string;
  tracks?: string[];
}

/** PATCH /api/playlists/:id */
export interface UpdatePlaylistRequest {
  name?: string;
  description?: string;
}

/** POST /api/playlists/:id/tracks → `added` new ones; tracks already in the playlist are skipped. */
export interface AddTracksResponse {
  added: number;
  playlist: MyPlaylist;
}

export type InstanceMode = 'per-user' | 'shared';

export interface SpotifyStatus {
  /** The Chromium instance this user's requests go through. */
  instance: number;
  mode: InstanceMode;
  /** Whether this user may log the instance in/out and open its screen (own instance, or admin). */
  canManage: boolean;
  browser: 'running' | 'stopped' | 'unreachable';
  loggedIn: boolean;
  account: string | null;
  /** Which Spotify queries Reddify has learned from the web player so far. */
  learned: string[];
}

export interface VncCredentials {
  password: string;
}

export type Role = 'admin' | 'user';

export interface Me {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  totp: boolean;
  local: boolean;
  oidc: boolean;
  csrf: string;
}

export interface AuthState {
  setupNeeded: boolean;
  localLogin: boolean;
  oidc: { enabled: boolean; label: string };
  me: Me | null;
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  local: boolean;
  oidc: boolean;
  totp: boolean;
  createdAt: number;
  lastSeen: number | null;
  instance: number;
}

export interface AdminSettings {
  instanceMode: InstanceMode;
  /** User id whose Chromium everyone uses in 'shared' mode. */
  sharedInstance: number;
  /** Which connection the server pulls audio from (Spotify capture, YouTube Music, or either with a preference). */
  audioSource: AudioSource;
}

export interface StorageStats {
  tracks: number;
  bytes: number;
  failed: number;
  downloading: number;
  /** Library files per source, so the admin can see which connection is actually delivering. */
  bySource: { youtube: number; spotify: number };
}

export interface SessionInfo {
  id: string;
  kind: 'web' | 'app';
  label: string;
  createdAt: number;
  lastSeen: number;
  current: boolean;
}

export interface ApiError {
  error: string;
  message: string;
}
