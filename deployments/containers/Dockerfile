FROM node:26-bookworm-slim AS client
WORKDIR /src/client
RUN corepack enable
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY client/ ./
RUN pnpm run build

FROM golang:1.26-bookworm AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /videocutlist ./cmd/server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin videocutlist \
    && mkdir -p /var/lib/videocutlist/data /var/lib/videocutlist/exports /var/cache/videocutlist/previews /srv/videocutlist/media
COPY --from=server /videocutlist /usr/local/bin/videocutlist
COPY --from=client /src/client/dist /opt/videocutlist/client/dist
RUN chown -R videocutlist:videocutlist /var/lib/videocutlist /var/cache/videocutlist /srv/videocutlist
USER videocutlist
WORKDIR /opt/videocutlist
ENV VIDEOCUTLIST_LISTEN_ADDRESS=0.0.0.0 \
    VIDEOCUTLIST_PORT=8787 \
    VIDEOCUTLIST_DATABASE_PATH=/var/lib/videocutlist/data/videocutlist.db \
    VIDEOCUTLIST_CACHE_DIR=/var/cache/videocutlist/previews \
    VIDEOCUTLIST_EXPORT_DIR=/var/lib/videocutlist/exports \
    VIDEOCUTLIST_MEDIA_ROOTS_JSON='{"media":"/srv/videocutlist/media"}' \
    VIDEOCUTLIST_FFMPEG_PATH=/usr/bin/ffmpeg \
    VIDEOCUTLIST_FFPROBE_PATH=/usr/bin/ffprobe
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl --fail --silent http://127.0.0.1:8787/api/v1/health || exit 1
ENTRYPOINT ["/usr/local/bin/videocutlist"]
