FROM node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS web
WORKDIR /src/web
RUN npm install --global pnpm@10.34.5
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm run build

FROM golang:1.26.9-bookworm@sha256:d9c68c2c51161e12fd77e4c6320687c9cd86e1af1e3ad6e6cd63ff970641453c AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist /src/internal/web/webassets/dist
RUN CGO_ENABLED=0 go build -tags embed_frontend -trimpath -o /videocutlist ./cmd/videocutlist

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin videocutlist \
    && mkdir -p /var/lib/videocutlist/data /var/lib/videocutlist/exports /var/cache/videocutlist/previews /srv/videocutlist/media
COPY --from=server /videocutlist /usr/local/bin/videocutlist
RUN chown -R videocutlist:videocutlist /var/lib/videocutlist /var/cache/videocutlist /srv/videocutlist
USER videocutlist
WORKDIR /opt/videocutlist
ENV VIDEOCUTLIST_LISTEN_ADDRESS=0.0.0.0 \
    VIDEOCUTLIST_AUTH_MODE=bearer \
    VIDEOCUTLIST_PORT=8787 \
    VIDEOCUTLIST_DATABASE_PATH=/var/lib/videocutlist/data/videocutlist.db \
    VIDEOCUTLIST_CACHE_DIR=/var/cache/videocutlist/previews \
    VIDEOCUTLIST_EXPORT_DIR=/var/lib/videocutlist/exports \
    VIDEOCUTLIST_MEDIA_ROOTS_JSON='{"media":"/srv/videocutlist/media"}' \
    VIDEOCUTLIST_FFMPEG_PATH=/usr/bin/ffmpeg \
    VIDEOCUTLIST_FFPROBE_PATH=/usr/bin/ffprobe
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl --fail --silent http://127.0.0.1:8787/health || exit 1
ENTRYPOINT ["/usr/local/bin/videocutlist"]
