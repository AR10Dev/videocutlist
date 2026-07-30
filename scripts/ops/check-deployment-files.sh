#!/usr/bin/env bash
# Repository-safe smoke check: syntax and static deployment invariants only.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
for script in "$root"/scripts/install/*.sh "$root"/scripts/ops/*.sh; do bash -n "$script"; done
grep -qx 'EDITAPP_LISTEN_ADDR=127.0.0.1:8787' "$root/deployments/systemd/editapp.env.example"
grep -qx 'PrivateDevices=yes' "$root/deployments/systemd/editapp.service"
grep -qx 'ProtectSystem=strict' "$root/deployments/systemd/editapp.service"
grep -qx 'ReadOnlyPaths=/srv/editapp/media' "$root/deployments/systemd/editapp.service"
grep -F 'install -d -o root -g editapp -m 0750 /etc/editapp' "$root/scripts/install/install-arch-cachyos.sh" >/dev/null
grep -F 'install -d -o root -g editapp -m 0770 /var/lib/editapp/data /var/lib/editapp/exports /var/cache/editapp/previews' "$root/scripts/install/install-arch-cachyos.sh" >/dev/null
grep -F 'mkdir -p "$stage/bin" "$stage/web/dist"' "$root/scripts/install/install-arch-cachyos.sh" >/dev/null
grep -F 'cp -a "$root/web/dist/." "$stage/web/dist/"' "$root/scripts/install/install-arch-cachyos.sh" >/dev/null
grep -F 'caps=${EDITAPP_TAILSCALE_APP_CAPS:-}' "$root/scripts/ops/setup-tailscale-serve.sh" >/dev/null
grep -F '[[ -n $caps ]] || { echo "EDITAPP_TAILSCALE_APP_CAPS is required" >&2; exit 2; }' "$root/scripts/ops/setup-tailscale-serve.sh" >/dev/null
grep -F 'args=(serve --bg --https=443 "--accept-app-caps=$caps" http://127.0.0.1:8787)' "$root/scripts/ops/setup-tailscale-serve.sh" >/dev/null
if command -v systemd-analyze >/dev/null; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  install -m 0755 /bin/true "$tmp/editapp"
  sed "s|/opt/editapp/current/bin/editapp|$tmp/editapp|" "$root/deployments/systemd/editapp.service" >"$tmp/editapp.service"
  systemd-analyze verify "$tmp/editapp.service"
fi
echo "deployment file checks passed"
