#!/usr/bin/env bash
# Configure optional private HTTPS. This script never invokes Funnel.
set -euo pipefail

if (( EUID != 0 )); then
  echo "run as root (for example: sudo $0)" >&2
  exit 1
fi
caps=${VIDEOCUTLIST_TAILSCALE_APP_CAPS:-}
[[ -n $caps ]] || { echo "VIDEOCUTLIST_TAILSCALE_APP_CAPS is required" >&2; exit 2; }
case $caps in
  *[!A-Za-z0-9./,:_-]*) echo "VIDEOCUTLIST_TAILSCALE_APP_CAPS has invalid characters" >&2; exit 2 ;;
esac
command -v tailscale >/dev/null || { echo "tailscale is not installed" >&2; exit 1; }
systemctl is-active --quiet tailscaled || { echo "tailscaled is not active" >&2; exit 1; }
systemctl is-active --quiet videocutlist || { echo "videocutlist is not active" >&2; exit 1; }
curl --fail --silent --show-error http://127.0.0.1:8787/api/v1/ready >/dev/null

tailscale serve --bg --https=443 "--accept-app-caps=$caps" http://127.0.0.1:8787
serve=$(tailscale serve status --json)
printf '%s\n' "$serve" | grep -F '127.0.0.1:8787' >/dev/null || { echo "Serve is not proxying 127.0.0.1:8787" >&2; exit 1; }
funnel=$(tailscale funnel status --json)
if printf '%s\n' "$funnel" | grep -qiE 'funnel (on|enabled)|"allowfunnel"[[:space:]]*:[[:space:]]*true'; then
  echo "Funnel is enabled; disable it before using this optional Serve configuration" >&2
  exit 1
fi
