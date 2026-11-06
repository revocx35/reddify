#!/bin/sh
# reddify capture container entrypoint: prepares the tmpfs directories, then drops from root to the chrome user (the
# browser's sandbox refuses to run as root) and hands over to the engine.
#
# The container holds no DAC_OVERRIDE on purpose: the volume and the tmpfs mounts are chowned to the browser's user,
# and everything inside them is created by that user through setpriv.
set -eu

: "${CONTROL_SECRET:?CONTROL_SECRET must be set}"

UG=10002
mkdir -p /run/pulse /run/capture /home/chrome /tmp/.X11-unix
chown -R "${UG}:${UG}" /run/pulse /run/capture /home/chrome
chown "${UG}:${UG}" /data
chmod 1777 /tmp/.X11-unix

as_chrome() {
  setpriv --reuid="${UG}" --regid="${UG}" --clear-groups "$@"
}

# The Chrome profile lives in the (persistent) volume: it holds the Spotify login of the engine's account.
as_chrome mkdir -p /data/profile /run/capture/recordings /run/capture/home /run/capture/tmp
as_chrome chmod 0700 /data/profile /run/capture/recordings

exec setpriv --reuid="${UG}" --regid="${UG}" --clear-groups node /app/dist/main.js
