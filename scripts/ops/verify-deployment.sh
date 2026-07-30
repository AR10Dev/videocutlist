#!/usr/bin/env bash
# Read-only deployment checks. Run as root to inspect all systemd state.
set -euo pipefail

command -v curl >/dev/null || { echo "missing curl" >&2; exit 1; }
curl --fail --silent --show-error http://127.0.0.1:8787/api/v1/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8787/api/v1/ready >/dev/null
systemctl is-active --quiet editapp
systemctl is-active --quiet tailscaled
ss -ltnH 'sport = :8787' | awk '$4 ~ /127\\.0\\.0\\.1:8787|\\[::1\\]:8787/ { found=1 } END { exit !found }'

command -v tailscale >/dev/null || { echo "missing tailscale" >&2; exit 1; }
serve=$(tailscale serve status --json)
printf '%s\\n' "$serve" | grep -F '127.0.0.1:8787' >/dev/null || { echo "Serve is not proxying 127.0.0.1:8787" >&2; exit 1; }
funnel=$(tailscale funnel status --json)
if printf '%s\\n' "$funnel" | grep -qiE 'funnel (on|enabled)|"allowfunnel"[[:space:]]*:[[:space:]]*true'; then
  echo "Funnel is enabled; disable it before using EditApp" >&2
  exit 1
fi
echo "EditApp health, loopback listener, private Serve target, and Funnel absence verified."
