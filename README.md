# Reddify

Your own music app with Spotify's catalogue: Spotify's home page, search, albums, artists, playlists and
recommendations, in a Spotify-like interface (in red), without ads. Songs play from your own server: the first play
of a song keeps it in Reddify's library; after that it plays from disk — for everyone, and even when Spotify is down.
The admin chooses where that first copy comes from: YouTube Music, Spotify itself (recorded from a real Spotify player
in a Chrome with Widevine), or either one with the other as fallback.

- Web app (desktop + phone), Android app (background playback, offline downloads), Chromecast from both.
- Your own playlists (create, edit, reorder, copy a Spotify playlist), private per user and playable offline.
- Smart Shuffle: the shuffle button's third setting mixes Spotify recommendations into the shuffled queue (marked ✦).
- Edit Your Library: remove playlists, albums and artists from Reddify (your Spotify account keeps them; restorable).
- Multi-user: everyone can have their own Spotify login (own Chromium), or the admin shares one browser.
- Audio from Spotify's own catalogue (exact, no wrong match) or YouTube Music (fast), per admin setting with fallback.
- Sign-in with authentik (OIDC) and/or local accounts with 2FA.

How it works and why: [ARCHITECTURE.md](ARCHITECTURE.md). Notes for AI agents: [AGENTS.md](AGENTS.md).

## Run it

```bash
scripts/setup.sh --site 192.168.1.50                 # LAN, HTTPS with Caddy's own CA
# or, behind your own reverse proxy (e.g. Nginx Proxy Manager) that terminates TLS:
scripts/setup.sh --site music.example.com --http-only
docker compose up -d --build
```
Open the site and create the admin with the setup token printed by `setup.sh` (or sign in with OIDC first).
Then **Settings → Spotify connection → Open the Spotify login** and log in on the browser screen (or paste your
`sp_dc` cookie). Without a Spotify login, browsing works anonymously (no personal home/recommendations).

### Spotify as the audio source

The stack runs a second browser — Google Chrome, the only one with Google's Widevine CDM — in the `capture` container.
It plays the song in Spotify's own web player into a virtual speaker inside that container, and Reddify records that
speaker and keeps it as lossless FLAC. Nothing is decrypted by us: Chrome plays, the CDM decrypts, the sink is read.

1. **Settings → Admin → Spotify audio → Log in to Spotify** (or paste an `sp_dc` cookie). Use a **separate account**,
   any tier — Spotify Free works: Spotify plays one stream per account, so recording from the account you listen on
   will interrupt your own playback. Free streams in the web player at AAC 128 kbit/s (Premium: 256), and when an
   advert comes before a track the engine waits it out instead of recording it.
2. **Settings → Admin → Audio source** picks the connection: *Spotify only*, *YouTube Music only*, *YouTube Music first,
   Spotify as fallback*, or *Spotify first, YouTube Music as fallback*.
3. **Test the capture** records a generated tone through the engine's own speaker and reports the length, the level, the
   codec and the Widevine levels Chrome offers — a one-click proof that the path works before any song is involved.

A Spotify capture is real time: the first play of a Spotify-sourced song starts a few seconds in and fills up as the song
plays (the app streams the file while it is written); every later play is a plain file from the library.

Adverts on a free account are waited out by the engine, so they never end up in a file. If you want them gone instead of
waited out, set `BLOCK_ADS=1` for the `capture` container: it sends Spotify's advert hosts to a dead address inside that
browser only (a network rule, because current Chrome no longer runs uBlock Origin — see ARCHITECTURE.md §5).

### authentik

1. OAuth2/OpenID provider (confidential), redirect URI `https://<site>/api/auth/oidc/callback`, signing key RS256,
   scopes openid/profile/email. Put issuer, client id and secret in `.env` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`). The first account becomes admin, and so does anyone in `OIDC_ADMIN_GROUP`.
2. For the Android app: a public PKCE provider `reddify-android`, redirect regex
   `^io\.github\.revocx35\.reddify(\.debug)?:/?/authentik$`, scopes + `offline_access`; set `OIDC_APP_ISSUER` and
   `OIDC_APP_CLIENT_ID=reddify-android`.
3. Optional forward auth in front (recommended): proxy provider in forward-auth (single application) mode with
   *intercept header auth*, federated with the Android provider (both directions). In NPM, exempt `location /cast/`
   from `auth_request` (Chromecasts fetch signed URLs there).

### Updating

`docker compose build --pull && docker compose up -d`. YouTube changes often: if songs stop downloading, raise
`YTDLP_VERSION` in the `Dockerfile` and rebuild.

## Android

[revocx35/reddify_android](https://github.com/revocx35/reddify_android) (Kotlin + Compose + Media3): APKs on its
releases page; a server built with the APK in `web/public/reddify.apk` also offers it under Settings → Android app.

## Notes

Reddify never decrypts Spotify's DRM-protected streams and never touches Widevine, its keys or its decrypted buffers:
the audio it captures comes out of a real Spotify player in a real Chrome, at the point where the browser has already
handed it to the operating system's audio stack (a virtual speaker inside its own container). Use it for your own
listening and respect the terms of the services involved.
