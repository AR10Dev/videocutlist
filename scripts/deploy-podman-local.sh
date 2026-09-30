#!/usr/bin/env bash
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
app_dir=${VIDEOCUTLIST_APP_DIR:-"$HOME/.config/podman/videocutlist"}
media_dir=${VIDEOCUTLIST_MEDIA_DIR:-"$app_dir/media"}

command -v podman >/dev/null || {
  echo "podman is unavailable; install or enable Podman before running this script." >&2
  exit 1
}
umask 077

mkdir -p "$app_dir" "$media_dir" "$app_dir/data" "$app_dir/cache" "$app_dir/exports"
cp -n "$repo/deployments/containers/compose.yaml" "$app_dir/compose.yaml"
cp -n "$repo/deployments/containers/videocutlist.env.example" "$app_dir/videocutlist.env"
chmod 600 -- "$app_dir/videocutlist.env"
if [ "$(podman info --format '{{.Host.Security.Rootless}}')" = "true" ]; then
  sudo chown -R "$(id -u):$(id -g)" "$app_dir/data" "$app_dir/cache" "$app_dir/exports"
  podman unshare chown -R 10001:10001 "$app_dir/data" "$app_dir/cache" "$app_dir/exports"
else
  sudo chown -R 10001:10001 "$app_dir/data" "$app_dir/cache" "$app_dir/exports"
fi

podman build -f "$repo/deployments/containers/Dockerfile" -t videocutlist:local "$repo"
if podman compose version >/dev/null 2>&1; then
  (
    cd "$app_dir"
    podman compose down
  )
fi
podman rm -f videocutlist-local 2>/dev/null || true
podman run -d --replace --name videocutlist-local \
  --restart unless-stopped \
  --network host \
  --env-file "$app_dir/videocutlist.env" \
  --env VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1 \
  --env VIDEOCUTLIST_AUTH_MODE=none \
  --volume "$app_dir/data:/var/lib/videocutlist/data" \
  --volume "$app_dir/cache:/var/cache/videocutlist/previews" \
  --volume "$app_dir/exports:/var/lib/videocutlist/exports" \
  --volume "$media_dir:/srv/videocutlist/media:ro" \
  videocutlist:local
podman ps --filter name=videocutlist-local
printf 'Deployed. Logs: podman logs -f videocutlist-local\n'
