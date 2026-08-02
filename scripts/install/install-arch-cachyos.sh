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
pacman -S --needed --noconfirm base-devel go nodejs npm ffmpeg sqlite curl jq

getent group editapp-media >/dev/null || groupadd --system editapp-media
id -u editapp >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --shell /usr/bin/nologin editapp
usermod -a -G editapp-media editapp

install -d -o root -g root -m 0755 /opt/editapp/releases
install -d -o root -g editapp -m 0750 /etc/editapp
install -d -o root -g editapp -m 0770 /var/lib/editapp/data /var/lib/editapp/exports /var/cache/editapp/previews
install -d -o root -g editapp-media -m 0750 /srv/editapp/media

stage=$(mktemp -d /opt/editapp/.install.XXXXXX)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/bin" "$stage/web/dist"
go -C "$root" build -trimpath -buildvcs=true -o "$stage/bin/editapp" ./cmd/server
npm --prefix "$root/web" ci
npm --prefix "$root/web" run build
cp -a "$root/web/dist/." "$stage/web/dist/"
cp -a "$root/docs" "$stage/docs"

release_dir="/opt/editapp/releases/$release"
if [[ -e $release_dir ]]; then
  echo "release already exists: $release_dir" >&2
  exit 1
fi
mv "$stage" "$release_dir"
ln -s "$release_dir" /opt/editapp/current.new
mv -Tf /opt/editapp/current.new /opt/editapp/current
install -m 0644 "$root/deployments/systemd/editapp.service" /etc/systemd/system/editapp.service
if [[ ! -e /etc/editapp/editapp.env ]]; then
  install -o root -g editapp -m 0640 "$root/deployments/systemd/editapp.env.example" /etc/editapp/editapp.env
fi
systemctl daemon-reload
echo "Installed $release_dir. Set EDITAPP_MEDIA_ROOTS_JSON in /etc/editapp/editapp.env, then run:"
echo "  systemctl enable --now editapp"
