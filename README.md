# Reddify

Your own music app with Spotify's catalogue: Spotify's home page, search, albums, artists, playlists and
recommendations, in a Spotify-like interface (in red), without ads. Songs play from your own server: the first play
of a song finds it on YouTube Music and keeps it in Reddify's library; after that it plays from disk — for everyone,
and even when Spotify is down.

- Web app (desktop + phone), Android app (background playback, offline downloads), Chromecast from both.
- Multi-user: everyone can have their own Spotify login (own Chromium), or the admin shares one browser.
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

Reddify never decrypts Spotify's DRM-protected streams; audio comes from YouTube Music. Use it for your own
listening and respect the terms of the services involved.
