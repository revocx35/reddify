# Reddify — architecture

Reddify is a self-hosted music app with Spotify's catalogue and a Spotify-like UI (red instead of green). Spotify
provides everything you browse (home, search, albums, artists, playlists, recommendations, the account's library),
read through a real Spotify web player running in a server-side Chromium. The **audio** is matched on YouTube Music
and downloaded once into a shared library; every later play, for every user, comes from that file — even when
Spotify is down.

## 1. Components

```
  browser / Android ──HTTPS──► reverse proxy (TLS, authentik forward auth)
                                  │ http
                                  ▼
                               caddy ──► app (Node 24, Fastify)          ──► YouTube Music / googlevideo (yt-dlp)
                                          │  SQLite + /data/library        ──► i.scdn.co (covers)
                                          │  CDP + VNC (bearer per user)   ──► authentik (OIDC, JWKS)
                                          ▼
                                       chromium (Go manager + one Chromium/Xvfb/x11vnc per instance) ──► open.spotify.com
```

| Container | What | Network |
|---|---|---|
| `caddy` | TLS (internal CA / LE) or plain HTTP behind NPM (`Caddyfile.http`); only published ports | public, edge |
| `app` | API + web UI + library + downloader; runs as uid 10001, read-only rootfs, no capabilities | edge, backend, egress |
| `chromium` | `chromium/manager` (Go, from tiktok_logger/insta_logger): starts one sandboxed Chromium per instance under its own uid, relays CDP and VNC only with that instance's HMAC token | backend, egress |
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

**Audio** (`server/src/library/`). First play of a track: `POST /api/tracks/:id/prepare` (or the stream request
itself) → `Downloader.ensure`: `py/ytm.py` (ytmusicapi) searches "artist title" on YouTube Music (songs, then
videos), `matcher.ts` scores candidates (title core words ≥ 50 %, artist, duration within 15 s, penalties for
live/remix/karaoke…) → `yt-dlp` (deno solves YouTube's JS challenge) writes the m4a straight into
`library/tmp/<id>.m4a` with `--no-part`; it prints `ext size` before the download, so `GET /api/stream/:id` already
serves Range requests from the growing file (`GrowingFileReader`). Done → moved to `library/<xx>/<id>.m4a`, cover
saved, `files` row `ready`, FTS index updated. Every later play — any user, any Spotify instance — is a plain file.
Failures are remembered for 10 min. Measured on a busy 3-core host: match 1.6 s, first byte ~9 s, done ~10 s; the player
prefetches the next queued track 15 s into the current one, so queues play gap-free.

**Offline / Spotify down.** Every Spotify-backed route catches "unavailable" (502/503) and falls back: search →
FTS over the library, home → recently played / liked / library, recommendations → random library tracks, stream →
file (metadata is in `tracks`). The Android app additionally keeps downloaded songs on the phone.

**Multi-user and instances.** Users: local (argon2id) or authentik (OIDC, auto-created; first user or
`OIDC_ADMIN_GROUP` = admin). Each user has their own Chromium instance (= their own Spotify login, personal home and
recommendations) unless the admin sets **shared mode** (`settings.instance_mode = shared`, one instance for all).
Idle browsers stop after `BROWSER_IDLE_MINUTES`. The library is shared by design (one file per Spotify track id).
Spotify login: the instance owner (or an admin) opens Spotify's login page in a second tab and types it on the live
screen (noVNC over `/api/vnc`), or pastes an `sp_dc` cookie. The tab closes itself once the `sp_dc` cookie exists.

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
- **Logs:** request logging is off (cast URLs carry a capability); tokens, headers and hashes are never logged.

## 4. Key decisions

- **No DRM circumvention.** Spotify streams are Widevine-encrypted; Reddify never decrypts them (and open-source
  Chromium has no Widevine anyway). Audio comes from YouTube Music, like spotDL. No Spotify ads ever play.
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
- pathfinder hashes change with web player releases — learned automatically.

## 6. Database (SQLite, `server/src/db/db.ts`)

`users`, `sessions`, `settings` (instance mode), `ops` (learned queries), `tracks` (metadata), `files` (library:
ready/failed, path, size, match), `plays`, `likes`, `audit` (180 days), `tracks_fts` (contentless FTS5 for offline
search). Migrations append-only.

## 7. Deployment

Recommended: Caddy in HTTP mode (`scripts/setup.sh --http-only`) behind a TLS reverse proxy with authentik forward
auth (proxy provider with intercept header auth, federated with the Android provider), `location /cast/` exempt from
auth and `proxy_buffering off` for streaming; an OIDC provider for the app login and a public PKCE provider for
Android (both with explicit grant types). See README.
