# reddify — catalogue browser container: one browser (headful under Xvfb, VNC for the live screen) per user, each
# under its own unix user, started on demand by the manager (manager/, Go, standard library only).
#
# The browser is Google Chrome, not Chromium: Spotify's own page checks for Widevine (EME) as it loads and, without a CDM,
# renders a degraded player that says "Playback of protected content is not enabled." This container reads the catalogue;
# it never plays or records anything (the audio comes from the YouTube match or from the capture container).
# Exposes (on the internal backend network only), with a per-user bearer token on every route:
#   9223/tcp  manager API: /i/<id>/ensure, /i/<id>/cdp/… (DevTools relay: version, tab list, browser websocket),
#             /i/<id>/vnc (tunnel to the user's x11vnc)
ARG GO_IMAGE=golang:1.24-bookworm

FROM ${GO_IMAGE} AS manager-build
WORKDIR /src
COPY manager/ ./
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rdf-chromium-manager .

FROM debian:trixie-slim

ARG DEBIAN_FRONTEND=noninteractive
ARG CHROME_CHANNEL=stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc \
      iproute2 curl ca-certificates tini findutils gnupg \
      fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core fonts-liberation \
      libgl1-mesa-dri libglx-mesa0 libegl-mesa0 libgl1 libegl1 \
 && curl -fsSL "https://dl.google.com/linux/direct/google-chrome-${CHROME_CHANNEL}_current_amd64.deb" -o /tmp/chrome.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Managed policy: lock the browser down to Spotify (and the Meta domains its login and media use).
# Managed policy: lock the browser down to Spotify (and the login providers its sign-in uses). Chrome reads its
# enterprise policies from /etc/opt/chrome, not /etc/chromium; the same URLBlocklist/URLAllowlist applies.
COPY policies.json /etc/opt/chrome/policies/managed/reddify.json
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --from=manager-build /out/rdf-chromium-manager /usr/local/bin/rdf-chromium-manager
# Tenant 1 (the first account) keeps the user of the single-user releases (uid 10002), so its Spotify session in
# /data/profile is still readable after an upgrade. The manager creates the other users' directories on demand and
# starts their browsers under uid 10100+<id> (it needs only CAP_SETUID/SETGID/CHOWN/KILL for that).
RUN chmod 0644 /etc/opt/chrome/policies/managed/reddify.json \
 && chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/rdf-chromium-manager \
 && groupadd -g 10002 chrome \
 && useradd -u 10002 -g 10002 -M -d /home/chrome -s /usr/sbin/nologin chrome \
 && mkdir -p /data /home/chrome \
 && chown 10002:10002 /data/ \
 && chmod 0700 /data

# The manager (root, bounded capabilities) drops every browser to its own unix user.
ENV SCREEN=1280x800x24
VOLUME ["/data"]
EXPOSE 9223
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:9223/healthz || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
