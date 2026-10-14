#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
for tool in podman node; do
  command -v "$tool" >/dev/null || {
    echo "$tool is required for the container smoke test." >&2
    exit 1
  }
done
if [ "$(podman info --format '{{.Host.Security.Rootless}}')" != true ]; then
  echo 'Run this disposable smoke test with rootless Podman.' >&2
  exit 1
fi
podman compose version >/dev/null
umask 077
work=$(mktemp -d)
project="vcl-smoke-$(basename "$work" | tr '[:upper:].' '[:lower:]-')"
image=${VIDEOCUTLIST_TEST_IMAGE:-"localhost/$project:local"}
container=
compose() { (cd "$work" && podman compose -p "$project" "$@"); }
cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ -n "$container" ]; then
    podman logs --tail 100 "$container" >&2 || true
  fi
  compose down >/dev/null 2>&1 || true
  podman unshare rm -rf -- "$work"
  if [ -z "${VIDEOCUTLIST_TEST_IMAGE:-}" ]; then
    podman image rm "$image" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

if [ -z "${VIDEOCUTLIST_TEST_IMAGE:-}" ]; then
  podman build --format docker -f "$repo/deployments/containers/Dockerfile" -t "$image" "$repo"
fi
cp "$repo/deployments/containers/compose.yaml" "$work/compose.yaml"
cp "$repo/deployments/containers/videocutlist.env.example" "$work/videocutlist.env"
token=$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')
printf 'VIDEOCUTLIST_BEARER_TOKEN=%s\n' "$token" >>"$work/videocutlist.env"
mkdir "$work/data" "$work/cache" "$work/exports" "$work/media"
podman unshare chown 10001:10001 "$work/data" "$work/cache" "$work/exports" "$work/media"
# Generate a real, small audio/video source using the image's own FFmpeg.
podman run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --volume "$work/media:/fixture" --entrypoint ffmpeg "$image" \
  -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x180:rate=25 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4 \
  -c:v libx264 -g 10 -pix_fmt yuv420p -c:a aac /fixture/clip.mp4
export VIDEOCUTLIST_IMAGE="$image"
VIDEOCUTLIST_HOST_PORT=$(node --input-type=module -e '
  import net from "node:net";
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });
')
export VIDEOCUTLIST_HOST_PORT
# Never inherit paths pointing to the operator's real media or application data.
export VIDEOCUTLIST_BIND_ADDRESS=127.0.0.1 VIDEOCUTLIST_DATA_DIR="$work/data"
export VIDEOCUTLIST_CACHE_DIR="$work/cache" VIDEOCUTLIST_EXPORT_DIR="$work/exports"
export VIDEOCUTLIST_MEDIA_DIR="$work/media"
compose up -d
container=$(compose ps -q)
[ -n "$container" ]
[ "$(podman inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$container")" = true ]
podman exec "$container" sh -ec '
  [ "$(id -u)" = 10001 ]
  grep -Eq "^CapEff:[[:space:]]+0+$" /proc/1/status
  grep -Eq "^CapBnd:[[:space:]]+0+$" /proc/1/status
  grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/1/status
  if touch /etc/vcl-smoke 2>/dev/null; then exit 1; fi
  if touch /srv/videocutlist/media/vcl-smoke 2>/dev/null; then exit 1; fi
  test -r /srv/videocutlist/media/clip.mp4
  temp=$(mktemp /tmp/vcl-smoke.XXXXXX)
  rm "$temp"
'
address=$(podman port "$container" 8787/tcp)
VIDEOCUTLIST_TEST_URL="http://$address" VIDEOCUTLIST_TEST_TOKEN="$token" \
  node "$repo/test/harness/container-smoke.mjs" "$container"
podman healthcheck run "$container"
echo 'Container smoke test passed: hardening, media, preview/cache, exports, temporary files, restart persistence.'
