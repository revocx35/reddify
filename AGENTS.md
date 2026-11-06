# AGENTS.md — notes for AI coding agents

Reddify: self-hosted music app. Spotify's catalogue (read through a Chromium running Spotify's web player), audio
matched on YouTube Music and kept in a shared library, Spotify-like web UI in red, native Android client, multi-user,
authentik. Read [ARCHITECTURE.md](ARCHITECTURE.md) first (design, data flow, threat model, deployment).

## Layout

| Path | What |
|---|---|
| `shared/api.d.ts` | HTTP API contract (types). Change it first, then server, web, and `core/.../Models.kt` in revocx35/reddify_android |
| `server/src/spotify/` | `session.ts` (CDP, learning ops/headers, in-page fetch, login tab, cookie import, pool), `parse.ts` (pathfinder → models), `catalog.ts` (queries + cache + offline fallbacks), `cdp.ts`, `chromium.ts` (manager client) |
| `server/src/library/` | `matcher.ts` (YouTube Music candidate scoring), `downloader.ts` (ytm.py + yt-dlp, jobs, covers), `stream.ts` (Range, growing-file reader) |
| `server/py/ytm.py` | ytmusicapi search helper (argv in, JSON out) |
| `server/src/auth/`, `api/auth.ts` | argon2id, throttle, TOTP, sessions, OIDC + JWT verifier, provisioning |
| `server/src/http/server.ts` | Fastify, auth resolution, CSRF/origin checks, headers, static web |
| `server/src/api/` | routes: auth, catalog, playback (+ cast), playlists (the users' own, private), spotify (+ VNC bridge), admin |
| `server/src/__fixtures__/` | real pathfinder answers (2026-11-06) the parser tests pin |
| `web/src/` | React UI: `pages/Layout.tsx` (sidebar, player bar, queue, mobile nav, now playing), `pages/Browse.tsx`, `pages/MyPlaylist.tsx` (own playlists), `pages/Settings.tsx`, `player/player.ts` (queue, autoplay, prefetch, Media Session), `player/cast.ts`, `player/playlists.ts`, `player/library.ts` (Your Library + edit mode) + `components/toast.tsx` |
| `chromium/` | Chromium image + Go manager (shared design with tiktok_logger/insta_logger), `policies.json` = Spotify allowlist |
| `scripts/setup.sh` | writes `.env`; `scripts/gen-android-icons.py` regenerates the Android client's icons from `web/src/components/Icon.tsx` (expects `../reddify_android`) |

## Commands

```bash
cd server && npm ci && npm test && npx tsc --noEmit          # 49 tests (vitest)
cd web && npm ci && npx tsc --noEmit && npm run build
cd capture && npm ci && npm test && npx tsc -p tsconfig.json --noEmit   # 11 tests (Spotify audio engine)
cd chromium/manager && go test ./...
docker compose build && docker compose up -d                   # after scripts/setup.sh
```
On shared build hosts cap heavy jobs (the owner's hosts: wrap them in `heavy`) and tear test stacks down (`docker compose -p <p> down`).

The Android client lives in **github.com/revocx35/reddify_android** (its own AGENTS.md: key, release steps). Its signed release APK is copied to `web/public/reddify.apk` (gitignored) before the
app image is built, so the server offers it in Settings → Android app.

## Deploy

Copy the repo to the server (keep its `.env`), then `docker compose build && docker compose up -d`. To ship the
Android APK with the server, copy the signed release APK to `web/public/reddify.apk` before building. Homelab
specifics (host, container, proxy and authentik object ids, where secrets live) are in the owner's shared notes, not
in this repo.

## Conventions

- Spotify is the client: never sign, mint or hard-code Spotify tokens or query hashes; learn them from the page.
- Treat everything from Spotify's page and YouTube as untrusted: validate ids, cap strings, parse defensively.
- New pathfinder operation: add it to `LEARN_URLS`, a parser + fixture test, then the route.
- Same look on web and Android: colours from the tokens (`web/src/styles.css` `:root`, `ui/theme/Theme.kt` in reddify_android),
  icons only via `Icon.tsx` + `scripts/gen-android-icons.py`.
- Every web UI change must reach the Android client in the same change (owner's rule).
- Update ARCHITECTURE.md, this file and README in the same commit as the change.

## Never

- Decrypt Spotify audio / touch Widevine, or play Spotify ads through the browser.
- Use `api.spotify.com/v1` (429 for web-player tokens) or log headers, tokens, cookies, hashes or cast URLs.
- Add inline scripts/styles to the CSP, weaken the Chromium policy/sandbox, or put the app on a network without authentik in front.
- Edit a shipped DB migration (append a new one).
- Run unbounded builds on a shared host, or test logins in loops against a live authentik (its IP reputation policy blocks everyone on that IP).

## Gotchas

- Home track cards have no duration: the server fetches `getTrack` before matching audio.
- `GrowingFileReader` must serialise reads (concurrent `_read` duplicated bytes once).
- yt-dlp reports `ext size` before it solves the JS challenge; the first audio bytes arrive ~4 s later.
- A track that YouTube Music cannot match fails for 10 minutes (status `failed`), then may be retried.
- Robolectric hands Media3's MediaController a null ComponentName: `PlayerConnection` does not connect under Robolectric.
- authentik OAuth2 providers created through the API get **empty `grant_types`**; authorize then fails with "The request is otherwise malformed" (Reddify logs `OIDC callback refused: provider said invalid_request`). Set `authorization_code` (+ `refresh_token` for Android) explicitly.
- authentik proxy providers reject partial PATCHes ("Internal host cannot be empty"): send the full body.
- The Android client sends its own `rdf_` token as `Authorization`; with authentik it moves to `X-App-Authorization` and NPM swaps it back, so the server accepts `rdf_` tokens on both headers.
- "Continue with Google" in the Spotify login hops through Google's **country domain** (`accounts.google.com.tr`, …) and `accounts.youtube.com` to set its cookies. Chromium's URL allowlist has no TLD wildcards, so each one is listed in `chromium/policies.json`; if a user from another country gets "blocked by administrator", add their `accounts.google.<tld>`.
- Own playlists live in Reddify's DB (`playlists`, `playlist_tracks`), not on Spotify: Spotify's playlist writes are not part of what the web player's pathfinder queries offer, and Reddify never mints its own Spotify calls. A Spotify playlist can be copied ("Save as my playlist"). Every playlist route checks the owner and answers 404 otherwise.
- Removing a Spotify item from Your Library only hides it in Reddify (`library_hidden`). Never turn this into a Spotify write (the owner explicitly wants Spotify left alone). The hide route looks the card up in the account's library, so it needs the Spotify browser logged in; restore does not.
- The capture engine's `waitFor()` resolves with **nothing**: map it with `.then(() => true, () => false)`, never test its result for truthiness (that made `openTrack` fail every Spotify capture with "did not render the track page" until 2026-11-06). The engine selftest plays a tone and never opens a track page, so it cannot catch track-page bugs; `capture/src/chrome.test.ts` does.
- Shelves (`.shelf-row`) give each card a fixed share of the row from a container-query column count (2…12). Never `minmax(…, 1fr)` there: a shelf with two cards then blows them up to half of an ultrawide screen.
- authentik users' display name is their authentik **username** (`preferred_username`), re-synced at every sign-in; authentik's `name` is often a placeholder ("authentik Default Admin").
