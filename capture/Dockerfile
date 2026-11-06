# reddify — Spotify audio engine. Google Chrome (the only browser here with Google's Widevine CDM) plays Spotify's own
# web player under Xvfb, into a PulseAudio null sink (the virtual speaker); the engine records that sink's monitor and
# encodes it to FLAC. Nothing here decrypts anything: the CDM decrypts, the browser plays, the sink is read.
#
# Build context: the repository root (the container shares shared/api.d.ts with the app).
#   9224/tcp  engine API (bearer token), including the growing FLAC of a running capture and a VNC tunnel for the login.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY capture/package.json capture/package-lock.json ./capture/
RUN cd capture && npm ci --no-audit --no-fund
COPY shared ./shared
COPY capture ./capture
RUN cd capture && npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_FRONTEND=noninteractive
ARG CHROME_CHANNEL=stable
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg tini util-linux \
      xvfb x11vnc \
      pulseaudio pulseaudio-utils \
      ffmpeg \
      fonts-noto-color-emoji fonts-noto-core fonts-dejavu-core fonts-liberation \
      libgl1-mesa-dri libglx-mesa0 libegl-mesa0 libgl1 libegl1 \
 && curl -fsSL "https://dl.google.com/linux/direct/google-chrome-${CHROME_CHANNEL}_current_amd64.deb" -o /tmp/chrome.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# The Chrome user (the browser's sandbox refuses to run as root) and the engine's own copy of the code.
RUN groupadd -g 10002 chrome \
 && useradd -u 10002 -g 10002 -M -d /home/chrome -s /usr/sbin/nologin chrome \
 && mkdir -p /app /data /home/chrome /run/capture \
 && chown 10002:10002 /data /home/chrome

WORKDIR /app
COPY --from=build /build/capture/dist ./dist
COPY --from=build /build/capture/node_modules ./node_modules
COPY --from=build /build/capture/package.json ./package.json
COPY capture/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=9224 \
    CHROME_PROFILE=/data/profile \
    WORK_DIR=/run/capture \
    PULSE_SERVER=unix:/run/pulse/native \
    SINK_NAME=reddify \
    RATE=44100 \
    CHANNELS=2 \
    TZ=UTC

VOLUME ["/data"]
EXPOSE 9224
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=4 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:9224/healthz || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
