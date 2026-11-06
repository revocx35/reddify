# Reddify — architecture

Reddify is a self-hosted music app with Spotify's catalogue and a Spotify-like UI (red instead of green). Spotify
provides everything you browse (home, search, albums, artists, playlists, recommendations, the account's library),
read through a real Spotify web player running in a server-side Chromium. The **audio** comes from either Spotify itself
— a separate Google Chrome with Widevine plays the track in the real web player and the engine records a virtual
speaker's output — or from YouTube Music, matched and downloaded once into a shared library. Every later play, for every
user, comes from that file — even when both Spotify and YouTube are down. The admin chooses the connection: Spotify only,
YouTube only, or either with the other as fallback.

## 1. Components

```
  browser / Android ──HTTPS──► reverse proxy (TLS, authentik forward auth)
                                  │ http
                                  ▼
                               caddy ──► app (Node 24, Fastify)          ──► YouTube Music / googlevideo (yt-dlp)
                                          │  SQLite + /data/library        ──► i.scdn.co (covers)
                                          │  CDP + VNC (bearer per user)   ──► authentik (OIDC, JWKS)
                                          │  HTTP + bearer (capture)
                                          ▼
                                       chromium (Go manager + one Chromium/Xvfb/x11vnc per instance) ──► open.spotify.com
                                          │
                                       capture (Google Chrome + Widevine under Xvfb, PulseAudio null sink,
                                                parec → ffmpeg/FLAC, VNC) ──► open.spotify.com (playback only)
```

| Container | What | Network |
|---|---|---|
| `caddy` | TLS (internal CA / LE) or plain HTTP behind NPM (`Caddyfile.http`); only published ports | public, edge |
| `app` | API + web UI + library + downloader; runs as uid 10001, read-only rootfs, no capabilities | edge, backend, egress |
| `chromium` | `chromium/manager` (Go, from tiktok_logger/insta_logger): starts one sandboxed Chromium per instance under its own uid, relays CDP and VNC only with that instance's HMAC token | backend, egress |
| `capture` | `capture/` (Node + Google Chrome): one Chrome with Widevine plays Spotify's web player into a PulseAudio null sink; the engine records that sink to FLAC and streams it to the app. Token = `HMAC(CONTROL_SECRET, 'rdf/capture/token')`. One engine for the whole server (audio is serial) | backend, egress |
| Android client | github.com/revocx35/reddify_android (Kotlin, Compose, Media3, Cast) | — |

## 2. Data flow

**Catalogue** (`server/src/spotify/`). `SpotifySession` attaches over CDP to the instance's open.spotify.com tab and
listens to `Network.requestWillBeSent` for the web player's own GraphQL calls (`api-partner.spotify.com/pathfinder`).
From them it learns (a) the current request headers (bearer, client-token, app version — refreshed by the player
itself) and (b) each operation's **persisted-query hash** and variable template (`ops` table). A query is replayed
**inside the page** with `fetch()` (Spotify's origin, cookies and TLS), variables merged over the template. Unknown
or stale (`PersistedQueryNotFound`) operations are learned by navigating the tab to a page that runs them
(`LEARN_URLS`). 401/403 → reload the tab for fresh headers; 429 → error to the user. `parse.ts` turns the answers into
`shared/api.d.ts` models (defensive; pinned by `src/__fixtures__`, captured 2026-11-06). Spotify's public Web API
(`api.spotify.com/v1`) is **not** used: it answers 429 to web-player tokens.

Operations used: `home`, `searchDesktop`, `searchTracks`, `getAlbum`, `queryArtistOverview`, `fetchPlaylist`,
`getTrack`, `internalLinkRecommenderTrack` (autoplay), `libraryV3` + `fetchLibraryTracks` (logged in only).

**Audio** (`server/src/library/`). The admin's `audio_source` setting decides the order the two connections are tried
(`sources.ts`): `youtube`, `spotify` (no fallback — the admin's choice is honoured), `youtube-preferred` or
`spotify-preferred` (the other one is tried when the first cannot deliver). A track is only ever stored once, in one
file, whichever connection produced it.

*YouTube Music*: first play of a track → `POST /api/tracks/:id/prepare` (or the stream request itself) → `Downloader.ensure`:
`py/ytm.py` (ytmusicapi) searches "artist title" on YouTube Music (songs, then videos), `matcher.ts` scores candidates
(title core words ≥ 50 %, artist, duration within 15 s, penalties for live/remix/karaoke…) → `yt-dlp` (deno solves
YouTube's JS challenge) writes the m4a straight into `library/tmp/<id>.m4a` with `--no-part`; it prints `ext size` before
the download, so `GET /api/stream/:id` already serves Range requests from the growing file (`GrowingFileReader`).

*Spotify* (the capture container): the engine opens `open.spotify.com/track/<id>` in its own Chrome (the only browser in
the stack with Google's Widevine CDM), starts `parec` on the monitor of a PulseAudio null sink ("the virtual speaker"),
presses play with a trusted CDP click, and encodes the sink to FLAC with ffmpeg. Before playing it reads the page's
Media Session and refuses the capture when the player's duration is not the track's (an advert, a free account, or a
queue that moved on), so the wrong audio can never become the file. The recorder starts the encoder at the first frame
above an audibility threshold (25 ms pre-roll) and stops at the track's own length, so the file starts where the music
starts; when it is finished ffmpeg has written the final STREAMINFO block, which is what makes the duration and the
seeking correct. Because the recording is real time, the app streams it **chunked while it is being written**
(`sendJob` with `job.live`, no Content-Length, no ranges): the first play starts a few seconds in and fills up as the
song plays. `files.source` records which connection produced each file.

Done → the file moves to `library/<xx>/<id>.<ext>`, cover saved, `files` row `ready`, FTS index updated. Every later play
— any user, any Spotify instance — is a plain file. Failures are remembered for 10 min. Measured on a busy 3-core host:
match 1.6 s, first byte ~9 s, done ~10 s for YouTube; 3-5 s to the first byte and the song's length for a Spotify
capture. The player prefetches the next queued track 15 s into the current one, so queues play gap-free (a Spotify-sourced
next track needs its own song-length of lead time).

**Offline / Spotify down.** Every Spotify-backed route catches "unavailable" (502/503) and falls back: search →
FTS over the library, home → recently played / liked / library, recommendations → random library tracks, stream →
file (metadata is in `tracks`). The Android app additionally keeps downloaded songs on the phone.

**Multi-user and instances.** Users: local (argon2id) or authentik (OIDC, auto-created; first user or
`OIDC_ADMIN_GROUP` = admin; display name = authentik username, re-synced at each sign-in). Each user has their own Chromium instance (= their own Spotify login, personal home and
recommendations) unless the admin sets **shared mode** (`settings.instance_mode = shared`, one instance for all).
Idle browsers stop after `BROWSER_IDLE_MINUTES`. The library is shared by design (one file per Spotify track id), and so
is the audio engine: one Spotify account records for everyone, set up once by an admin (Settings → Admin → Spotify audio).
Spotify login: the instance owner (or an admin) opens Spotify's login page in a second tab and types it on the live
screen (noVNC over `/api/vnc`), or pastes an `sp_dc` cookie. The tab closes itself once the `sp_dc` cookie exists.

**Own playlists** (`api/playlists.ts`). Users create, rename, describe, reorder (drag on the web, move up/down on
Android), add to and delete their own playlists; a Spotify playlist can be copied into one ("Save as my playlist",
up to 1000 songs). They are stored in Reddify's DB, private to the owner (every route answers 404 for anyone else's
id), work offline like Liked Songs (tracks keep their metadata in `tracks`), and never touch the Spotify account:
writing Spotify playlists would need calls the web player's learned queries do not cover. A track appears once per
playlist; positions are dense (0…n-1). Limits: 1000 playlists per user, 10 000 songs per playlist.

**Casting.** Web: Google Cast sender SDK (Chrome only, loaded from gstatic). Android: Cast framework, "mirroring"
(local ExoPlayer runs muted, track changes / play / pause / seek are repeated on the Chromecast). Both use
`POST /api/tracks/:id/cast` → `https://<origin>/cast/<trackId>.<exp>.<uid>.<hmac>`: a 12-hour capability for one
track, the only unauthenticated media route (a Chromecast has no session). The proxy exempts `/cast/` from authentik.

## 3. Security model / threat model

Assets: user accounts and sessions, Spotify logins in the Chromium profiles, the admin's settings. Attackers: the
internet (the site is public), a malicious web page (CSRF), a curious household user, a compromised Spotify page.

- **Outer gate:** reverse proxy + authentik forward auth for everything except `/cast/` (HMAC) — the app is not reachable
  without an authentik session or an authentik bearer token.
- **Login:** OIDC (code + PKCE + state + nonce, ID token verified via JWKS, iss/aud/exp) or local accounts: argon2id
  (19 MiB, t=2), constant-time miss, per-IP + per-account throttling (429 + lockout), optional TOTP (replay-protected),
  first admin only with the one-time `SETUP_TOKEN`, admin-created users get a temporary password they must change.
- **Sessions:** 256-bit random tokens, only SHA-256 stored, `__Host-reddify` cookie (Secure, HttpOnly, SameSite=Lax),
  idle 14 d + absolute 90 d, new session on every login, logout deletes the row, password change ends other sessions,
  disabling a user ends all. Android: same token as `Authorization`/`X-App-Authorization: Bearer rdf_…`, or the
  authentik access token (JWT of the `reddify-android` provider, verified via JWKS).
- **CSRF / cross-site:** unsafe methods with a cookie need the per-session `x-csrf-token`; any request with a
  cross-site `Sec-Fetch-Site` or a foreign `Origin` is refused (also logins); WebSockets need a same Origin.
- **Headers:** strict CSP (no inline script; gstatic only for the Cast SDK; images only from Spotify's CDN), HSTS,
  `X-Frame-Options: DENY`, nosniff, `Referrer-Policy: no-referrer`, `no-store` on the API. Errors are generic.
- **Input:** zod on every body/query/param; Spotify ids `^[A-Za-z0-9]{22}$`; YouTube ids `^[A-Za-z0-9_-]{11}$`;
  child processes get argv arrays (no shell); everything from Spotify's page is parsed defensively and capped; image
  URLs only from `*.scdn.co` / `*.spotifycdn.com`; CDP expressions embed only `JSON.stringify` literals.
- **Abuse:** per-IP request budget, body limit 64 KiB, max 3 parallel downloads, file size cap 200 MB.
- **Isolation:** the Chromium policy allows only Spotify + its login providers' hosts (Google's sign-in also needs its country domains, listed one by one); each instance runs under its
  own uid with the Chromium sandbox on; the manager accepts only the instance's HMAC token (derived from
  `CONTROL_SECRET`, which the browsers never see). Containers: read-only rootfs, `cap_drop: ALL`,
  `no-new-privileges`, app as non-root.
- **Not protected against:** an admin (sees all users, can stop browsers); a Reddify user who can manage the shared
  instance sees that Spotify account's screen. The library is shared: everyone sees what anyone played.
- **The audio engine** (`capture`) holds one Spotify account for the whole server, set up by an admin only (login over
  VNC, or an `sp_dc` cookie pasted in the admin panel — the cookie is never logged and never leaves the container).
  Its Chrome runs as an unprivileged uid inside a read-only, capability-stripped container with the same seccomp profile
  as the catalogue browser; the engine's HTTP API, its growing-audio route and its VNC tunnel are reachable only on the
  internal `backend` network and only with the derived bearer token. The engine's Chrome plays through a PulseAudio null
  sink inside that container, so no other process on the host can listen to it, and nothing on the host can inject audio
  into a recording.
- **Logs:** request logging is off (cast URLs carry a capability); tokens, headers and hashes are never logged.

## 4. Key decisions

- **No DRM circumvention.** Spotify streams are Widevine-encrypted. The engine never touches the CDM, the keys or the
  decrypted buffers: a stock Google Chrome (the only build with Widevine) plays the track through Spotify's own player,
  and the engine records what the browser has already handed to the operating system's audio stack — a virtual speaker
  inside its own container. That is the same thing a sound card driver would see, and it is why the audio is FLAC (the
  decoded PCM, losslessly) and not the original AAC stream.
- **Two connections, one choice.** YouTube Music (matching + yt-dlp, like spotDL) is fast, unpolluted and needs no
  account; Spotify's own player is exact (no wrong match possible), but real time — one song takes one song — and wants a
  Premium account of its own. The admin decides, including the fallback order, and the setting is stored in `settings`
  (`audio_source`) so it survives restarts.
- **Replay the web player, don't reimplement it.** Hashes/headers are learned from the page; nothing is signed or
  minted by Reddify. Spotify's Web API is rate-limited for these tokens, pathfinder isn't.
- **One file per Spotify track id**, shared by all users and instances ("prefer the local copy").
- **AAC/m4a** (YouTube itag 140, `--fixup never`) plays in Chrome, Firefox, Safari, ExoPlayer and Chromecast; the
  bytes on disk equal the bytes streamed during the first play.

## 5. Platform constraints

- YouTube requires PO tokens for most player clients; only yt-dlp's default client works without one (2026-11).
  When downloads start failing, bump `YTDLP_VERSION` in the Dockerfile and rebuild.
- yt-dlp's JS challenge (deno) dominates first-play latency (~4 s); node is slower.
- Playwright's Chromium has no AAC decoder (screenshot runs show "cannot play"); Debian Chromium / Chrome do.
- **Widevine only exists in Google Chrome**, not in Debian's Chromium or Playwright's — that is why the capture container
  installs Chrome's own .deb, and it is the reason the engine is a separate container instead of another instance in the
  catalogue's Chromium manager. Widevine also refuses to initialise in headless mode, hence Xvfb.
- A capture is real time and needs the engine's account to be free: Spotify plays one stream per account, so recording
  from the same account someone is listening on stops their playback. Use a dedicated Premium account.
- A free account injects adverts into the stream; the engine detects them (the player's duration is not the track's) and
  fails the capture rather than storing an advert.
- The FLAC file is written while the song plays, so its STREAMINFO length is only final after ffmpeg exits; a client that
  seeks during that first play may see an unknown duration. Every later play reads the finished file.
- pathfinder hashes change with web player releases — learned automatically.

## 6. Database (SQLite, `server/src/db/db.ts`)

`users`, `sessions`, `settings` (instance mode, `audio_source`), `ops` (learned queries), `tracks` (metadata), `files` (library:
ready/failed, path, size, mime, `source` = youtube|spotify, match), `plays`, `likes`, `playlists` + `playlist_tracks` (own playlists,
migration 2), `audit` (180 days), `tracks_fts` (contentless FTS5 for offline search). Migrations append-only.

## 7. Deployment

Recommended: Caddy in HTTP mode (`scripts/setup.sh --http-only`) behind a TLS reverse proxy with authentik forward
auth (proxy provider with intercept header auth, federated with the Android provider), `location /cast/` exempt from
auth and `proxy_buffering off` for streaming; an OIDC provider for the app login and a public PKCE provider for
Android (both with explicit grant types). See README.
