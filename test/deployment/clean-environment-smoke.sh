#!/usr/bin/env bash
# Runs the neutral verifier with no provider binaries, services, or variables.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

printf '%s\n' '#!/bin/sh' 'case "$*" in *tailscale*|*tailscaled*) exit 89;; esac' 'exit 0' >"$tmp/bin/systemctl"
printf '%s\n' '#!/bin/sh' 'case "$*" in *"http://127.0.0.1:8787/api/v1/health"*|*"http://127.0.0.1:8787/api/v1/ready"*) exit 0;; esac' 'exit 90' >"$tmp/bin/curl"
printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:*"' >"$tmp/bin/ss"
chmod 0755 "$tmp/bin/systemctl" "$tmp/bin/curl" "$tmp/bin/ss"

path=$tmp/bin:/usr/bin:/bin
if PATH=$path command -v tailscale >/dev/null; then
	echo "tailscale unexpectedly available in clean smoke PATH" >&2
	exit 1
fi
env -i PATH=$path EDITAPP_LISTEN_ADDRESS=127.0.0.1 EDITAPP_PORT=8787 EDITAPP_AUTH_MODE=none \
	bash "$root/scripts/ops/verify-deployment.sh"
echo "clean environment smoke passed"
