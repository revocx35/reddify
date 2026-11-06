import type {
  AddTracksResponse,
  AdminSettings,
  AdminUser,
  AlbumResponse,
  ArtistResponse,
  AuthState,
  CaptureSelftest,
  CaptureStatus,
  CastResponse,
  HomeResponse,
  LibraryResponse,
  Me,
  MyPlaylist,
  MyPlaylistResponse,
  PlaylistResponse,
  PrepareResponse,
  SearchResponse,
  SessionInfo,
  SpotifyStatus,
  StorageStats,
  Track,
  TrackPage,
  VncCredentials,
} from '../../../shared/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrf = '';
export function setCsrf(token: string): void {
  csrf = token;
}

/** Called when any request comes back 401 (session ended): the app shows the login page. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (!r.ok) {
    let code = 'error';
    let message = `Request failed (${r.status})`;
    try {
      const j = (await r.json()) as { error?: string; message?: string };
      code = j.error ?? code;
      message = j.message ?? message;
    } catch {
      /* not JSON */
    }
    if (r.status === 401 && code === 'unauthorized') onUnauthorized();
    throw new ApiError(r.status, code, message);
  }
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

const get = <T,>(url: string, signal?: AbortSignal) => request<T>('GET', url, undefined, signal);
const post = <T,>(url: string, body?: unknown) => request<T>('POST', url, body ?? {});
const enc = encodeURIComponent;

export const api = {
  // auth
  state: () => get<AuthState>('/api/auth/state'),
  setup: (setupToken: string, username: string, password: string) =>
    post<{ me: Me; mustChangePassword: boolean }>('/api/auth/setup', { setupToken, username, password }),
  login: (username: string, password: string, totp?: string) =>
    post<{ me: Me; mustChangePassword: boolean }>('/api/auth/login', { username, password, totp: totp || undefined }),
  logout: () => post<{ ok: true; providerLogout: string | null }>('/api/auth/logout'),
  changePassword: (current: string, next: string) => post('/api/me/password', { current, next }),
  totpSetup: () => post<{ secret: string; url: string }>('/api/me/totp/setup'),
  totpConfirm: (code: string) => post('/api/me/totp/confirm', { code }),
  totpDisable: (code: string) => post('/api/me/totp/disable', { code }),
  sessions: () => get<SessionInfo[]>('/api/me/sessions'),
  revokeSession: (id: string) => request('DELETE', `/api/me/sessions/${id}`),

  // catalogue
  home: (signal?: AbortSignal) => get<HomeResponse>('/api/home', signal),
  search: (q: string, signal?: AbortSignal) => get<SearchResponse>(`/api/search?q=${enc(q)}`, signal),
  searchTracks: (q: string, offset: number) => get<TrackPage>(`/api/search/tracks?q=${enc(q)}&offset=${offset}`),
  album: (id: string) => get<AlbumResponse>(`/api/album/${enc(id)}`),
  artist: (id: string) => get<ArtistResponse>(`/api/artist/${enc(id)}`),
  playlist: (id: string, offset = 0) => get<PlaylistResponse>(`/api/playlist/${enc(id)}?offset=${offset}`),
  track: (id: string) => get<Track>(`/api/track/${enc(id)}`),
  recommendations: (id: string) => get<Track[]>(`/api/track/${enc(id)}/recommendations`),

  // library
  library: () => get<LibraryResponse>('/api/library'),
  liked: () => get<Track[]>('/api/library/liked'),
  likedIds: () => get<string[]>('/api/library/liked/ids'),
  like: (id: string, on: boolean) => request(on ? 'PUT' : 'DELETE', `/api/library/liked/${enc(id)}`),
  spotifyLiked: (offset: number) => get<TrackPage>(`/api/library/spotify-liked?offset=${offset}`),
  downloads: (q: string, offset: number) => get<TrackPage>(`/api/library/downloads?q=${enc(q)}&offset=${offset}`),
  recent: () => get<Track[]>('/api/library/recent'),

  // own playlists
  myPlaylists: () => get<MyPlaylist[]>('/api/playlists'),
  myPlaylist: (id: number, signal?: AbortSignal) => get<MyPlaylistResponse>(`/api/playlists/${id}`, signal),
  createPlaylist: (body: { name?: string; description?: string; tracks?: string[] }) => post<MyPlaylistResponse>('/api/playlists', body),
  updatePlaylist: (id: number, body: { name?: string; description?: string }) => request<MyPlaylist>('PATCH', `/api/playlists/${id}`, body),
  deletePlaylist: (id: number) => request('DELETE', `/api/playlists/${id}`),
  addToPlaylist: (id: number, ids: string[]) => post<AddTracksResponse>(`/api/playlists/${id}/tracks`, { ids }),
  removeFromPlaylist: (id: number, trackId: string) => request<MyPlaylist>('DELETE', `/api/playlists/${id}/tracks/${enc(trackId)}`),
  movePlaylistTrack: (id: number, trackId: string, to: number) => request<MyPlaylist>('PUT', `/api/playlists/${id}/tracks/${enc(trackId)}/position`, { to }),
  trackPlaylists: (id: string) => get<number[]>(`/api/tracks/${enc(id)}/playlists`),

  // playback
  prepare: (id: string) => post<PrepareResponse>(`/api/tracks/${enc(id)}/prepare`),
  status: (id: string) => get<PrepareResponse>(`/api/tracks/${enc(id)}/status`),
  played: (id: string) => post(`/api/tracks/${enc(id)}/played`),
  cast: (id: string) => post<CastResponse>(`/api/tracks/${enc(id)}/cast`),
  streamUrl: (id: string) => `/api/stream/${enc(id)}`,
  downloadUrl: (id: string) => `/api/stream/${enc(id)}?download=1`,

  // spotify browser
  spotifyStatus: () => get<SpotifyStatus>('/api/spotify/status'),
  spotifyConnect: () => post('/api/spotify/connect'),
  spotifyLogin: () => post('/api/spotify/login'),
  spotifyCookie: (spDc: string) => post('/api/spotify/cookie', { spDc }),
  spotifyLogout: () => post('/api/spotify/logout'),
  spotifyRestart: () => post('/api/spotify/restart'),
  vncCredentials: () => get<VncCredentials>('/api/vnc/credentials'),

  // admin
  users: () => get<AdminUser[]>('/api/admin/users'),
  createUser: (username: string, role: 'admin' | 'user') =>
    post<{ user: AdminUser; temporaryPassword: string }>('/api/admin/users', { username, role }),
  updateUser: (id: number, patch: { role?: 'admin' | 'user'; disabled?: boolean }) => request<AdminUser>('PATCH', `/api/admin/users/${id}`, patch),
  resetPassword: (id: number) => post<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`),
  deleteUser: (id: number) => request('DELETE', `/api/admin/users/${id}`),
  stopBrowser: (id: number) => post(`/api/admin/users/${id}/browser/stop`),
  adminSettings: () => get<AdminSettings>('/api/admin/settings'),
  saveAdminSettings: (s: AdminSettings) => request<AdminSettings>('PUT', '/api/admin/settings', s),
  storage: () => get<StorageStats>('/api/admin/storage'),

  // the Spotify audio engine (capture container)
  captureStatus: () => get<CaptureStatus>('/api/admin/capture'),
  captureEnsure: () => post<CaptureStatus>('/api/admin/capture/ensure'),
  captureRestart: () => post<CaptureStatus>('/api/admin/capture/restart'),
  captureLogin: () => post('/api/admin/capture/login'),
  captureCookie: (spDc: string) => post<CaptureStatus>('/api/admin/capture/cookie', { spDc }),
  captureLogout: () => post<CaptureStatus>('/api/admin/capture/logout'),
  captureSelftest: () => post<CaptureSelftest>('/api/admin/capture/selftest'),
  captureVncCredentials: () => get<VncCredentials>('/api/admin/capture/vnc/credentials'),
};
