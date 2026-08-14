#!/usr/bin/env bash
# Builds the checked-out revision and installs it as an immutable release.
set -euo pipefail

if (( EUID != 0 )); then
  echo "run as root (for example: sudo $0 [release-name])" >&2
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
release=${1:-$(git -C "$root" rev-parse --short HEAD)}
case $release in
  ''|*[!A-Za-z0-9._-]*) echo "release name must be alphanumeric plus ._-" >&2; exit 2 ;;
esac

for command in pacman systemctl install git; do command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 1; }; done
pacman -S --needed --noconfirm base-devel go nodejs pnpm ffmpeg sqlite curl

getent group videocutlist-media >/dev/null || groupadd --system videocutlist-media
id -u videocutlist >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --shell /usr/bin/nologin videocutlist
usermod -a -G videocutlist-media videocutlist

install -d -o root -g root -m 0755 /opt/videocutlist/releases
install -d -o root -g videocutlist -m 0750 /etc/videocutlist
install -d -o root -g videocutlist -m 0770 /var/lib/videocutlist/data /var/lib/videocutlist/exports /var/cache/videocutlist/previews
install -d -o root -g videocutlist-media -m 0750 /srv/videocutlist/media

stage=$(mktemp -d /opt/videocutlist/.install.XXXXXX)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/client/dist"
go -C "$root" build -trimpath -buildvcs=true -o "$stage/bin/videocutlist" ./cmd/server
pnpm --dir "$root/client" install --frozen-lockfile
pnpm --dir "$root/client" run build
cp -a "$root/client/dist/." "$stage/client/dist/"
cp -a "$root/docs" "$stage/docs"

release_dir="/opt/videocutlist/releases/$release"
if [[ -e $release_dir ]]; then
  echo "release already exists: $release_dir" >&2
  exit 1
fi
mv "$stage" "$release_dir"
ln -s "$release_dir" /opt/videocutlist/current.new
mv -Tf /opt/videocutlist/current.new /opt/videocutlist/current
install -m 0644 "$root/deployments/systemd/videocutlist.service" /etc/systemd/system/videocutlist.service
if [[ ! -e /etc/videocutlist/videocutlist.env ]]; then
  install -o root -g videocutlist -m 0640 "$root/deployments/systemd/videocutlist.env.example" /etc/videocutlist/videocutlist.env
fi
systemctl daemon-reload
echo "Installed $release_dir. Set VIDEOCUTLIST_MEDIA_ROOTS_JSON in /etc/videocutlist/videocutlist.env, then run:"
echo "  systemctl enable --now videocutlist"
