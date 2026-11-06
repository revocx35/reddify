#!/usr/bin/env bash
# Creates .env for Reddify with strong random secrets.
#
#   scripts/setup.sh --site 192.168.1.50                       # LAN / IP address (Caddy's internal CA, HTTPS)
#   scripts/setup.sh --site music.example.com --email me@x.y   # public domain, Caddy gets a Let's Encrypt cert
#   scripts/setup.sh --site music.example.com --http-only      # behind your own TLS reverse proxy (e.g. NPM)
#   options: --public-origin https://music.example.com --timezone Europe/Istanbul --env-file .env --force
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SITE="" EMAIL="" ENV_FILE=".env" FORCE=0 HTTP_ONLY=0 TIMEZONE="" ORIGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --timezone) TIMEZONE="$2"; shift 2 ;;
    --public-origin) ORIGIN="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --http-only) HTTP_ONLY=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$ENV_FILE" && $FORCE -ne 1 ]]; then
  echo "$ENV_FILE already exists; refusing to overwrite it (it holds your secrets). Use --force for new ones." >&2
  exit 1
fi
[[ -n "$SITE" ]] || { echo "--site is required" >&2; exit 2; }
SITE="${SITE#http://}"; SITE="${SITE#https://}"; SITE="${SITE%%/*}"
[[ "$SITE" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "invalid site address: $SITE" >&2; exit 2; }

rand() { ( set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" ); }
TZ_NAME="${TIMEZONE:-$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC) | head -1)}"

if [[ $HTTP_ONLY -eq 1 ]]; then
  CADDY_CONFIG="Caddyfile.http"; CADDY_TLS="internal"; TRUST_PROXY=2; HTTPS_BIND="127.0.0.1"; COOKIE_SECURE="auto"
  ORIGIN="${ORIGIN:-https://$SITE}"
else
  CADDY_CONFIG="Caddyfile"; CADDY_TLS="${EMAIL:-internal}"; TRUST_PROXY=1; HTTPS_BIND="0.0.0.0"; COOKIE_SECURE="true"
  ORIGIN="${ORIGIN:-https://$SITE}"
fi
SETUP_TOKEN="$(rand 32)"

umask 077
cat >"$ENV_FILE" <<ENV
# Reddify settings (generated $(date -u +%Y-%m-%dT%H:%MZ)). Keep this file private.
SITE_ADDRESS=$SITE
CADDY_CONFIG=$CADDY_CONFIG
CADDY_TLS=$CADDY_TLS
HTTPS_BIND=$HTTPS_BIND
TRUST_PROXY=$TRUST_PROXY
COOKIE_SECURE=$COOKIE_SECURE
PUBLIC_ORIGIN=$ORIGIN
TZ=$TZ_NAME

# Shared by app and chromium only: the manager derives each user's browser token from it.
CONTROL_SECRET=$(rand 64)
# One-time token to create the first admin on the login page (not needed when you sign in with OIDC first).
SETUP_TOKEN=$SETUP_TOKEN
LOCAL_LOGIN=true

# OpenID Connect (authentik). The first account to sign in becomes admin; so does anyone in OIDC_ADMIN_GROUP.
# Redirect URI to register at the provider: \${PUBLIC_ORIGIN}/api/auth/oidc/callback
OIDC_ISSUER=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_LABEL=authentik
OIDC_ADMIN_GROUP=authentik Admins
# The Android client's own public PKCE provider (its access tokens are accepted as Authorization: Bearer).
OIDC_APP_ISSUER=
OIDC_APP_CLIENT_ID=

MAX_USERS=10
MAX_PARALLEL_DOWNLOADS=3
BROWSER_IDLE_MINUTES=120
ENV
echo "Wrote $ENV_FILE."
echo "Setup token for the first admin account: $SETUP_TOKEN"
echo "Start:  docker compose up -d --build   then open $ORIGIN"
