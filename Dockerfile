# Reddify app image: web UI + Node server + the audio tools (yt-dlp, ytmusicapi, deno for YouTube's JS challenges).
# Build context: repository root.

ARG NODE_IMAGE=node:24-trixie-slim

# ---------------------------------------------------------------- web UI
FROM ${NODE_IMAGE} AS web-build
WORKDIR /build
COPY shared ./shared
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
RUN cd web && npm run build

# ---------------------------------------------------------------- server
FROM ${NODE_IMAGE} AS server-build
WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY shared ./shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --no-audit --no-fund
COPY server ./server
RUN cd server && npm run build && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- python tools
FROM ${NODE_IMAGE} AS py-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# yt-dlp changes often to keep up with YouTube: bump YTDLP_VERSION and rebuild when downloads start failing.
ARG YTDLP_VERSION=2026.10.26
ARG YTMUSICAPI_VERSION=1.11.1
ARG DENO_VERSION=2.9.8
RUN python3 -m venv /opt/py \
 && /opt/py/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" "ytmusicapi==${YTMUSICAPI_VERSION}" "deno==${DENO_VERSION}" \
 && /opt/py/bin/yt-dlp --version && /opt/py/bin/deno --version

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 reddify \
 && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin reddify \
 && mkdir -p /data && chown 10001:10001 /data && chmod 0700 /data \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
COPY --from=py-build /opt/py /opt/py
ENV NODE_ENV=production \
    PATH=/opt/py/bin:$PATH \
    WEB_DIR=/app/web \
    HELPER_DIR=/app/py \
    PYTHON_BIN=/opt/py/bin/python3 \
    YTDLP_BIN=/opt/py/bin/yt-dlp \
    DATA_DIR=/data \
    HOME=/tmp \
    DENO_DIR=/tmp/deno \
    XDG_CACHE_HOME=/tmp/cache \
    PORT=8080
WORKDIR /app
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
COPY server/py ./py
COPY --from=web-build /build/web/dist ./web
USER 10001:10001
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--disable-proto=delete", "dist/index.js"]
