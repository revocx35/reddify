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
  /** The Spotify account's own playlists (empty when the browser is not logged in). Read-only. */
  playlists: Card[];
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
}

export interface StorageStats {
  tracks: number;
  bytes: number;
  failed: number;
  downloading: number;
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
