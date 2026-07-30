#!/usr/bin/env bash
# Configure a private HTTPS reverse proxy. This script never invokes Funnel.
set -euo pipefail

if (( EUID != 0 )); then
  echo "run as root (for example: sudo $0)" >&2
  exit 1
fi
caps=${EDITAPP_TAILSCALE_APP_CAPS:-}
[[ -n $caps ]] || { echo "EDITAPP_TAILSCALE_APP_CAPS is required" >&2; exit 2; }
case $caps in
  *[!A-Za-z0-9./,:_-]*) echo "EDITAPP_TAILSCALE_APP_CAPS has invalid characters" >&2; exit 2 ;;
esac
command -v tailscale >/dev/null || { echo "tailscale is not installed" >&2; exit 1; }
systemctl is-active --quiet tailscaled || { echo "tailscaled is not active" >&2; exit 1; }
systemctl is-active --quiet editapp || { echo "editapp is not active" >&2; exit 1; }
curl --fail --silent --show-error http://127.0.0.1:8787/api/v1/ready >/dev/null

args=(serve --bg --https=443 "--accept-app-caps=$caps" http://127.0.0.1:8787)
tailscale "${args[@]}"
"$(dirname "${BASH_SOURCE[0]}")/verify-deployment.sh"
