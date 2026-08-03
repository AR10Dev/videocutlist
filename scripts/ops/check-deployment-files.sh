#!/usr/bin/env bash
# Static checks for the transport-neutral primary deployment path.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
env_file=$root/deployments/systemd/videocutlist.env.example
unit=$root/deployments/systemd/videocutlist.service
installer=$root/scripts/install/install-arch-cachyos.sh
verifier=$root/scripts/ops/verify-deployment.sh
optional=$root/deployments/connectivity-examples/tailscale/setup-tailscale-serve.sh

fail() { echo "deployment check: $*" >&2; exit 1; }
require_line() { grep -Fqx "$1" "$2" || fail "missing $1 in $2"; }
forbid_provider() {
	if grep -Ein 'tailscale|tailscaled|tailnet|VIDEOCUTLIST_TAILSCALE|funnel' "$1" >/dev/null; then
		fail "primary path depends on a connectivity provider: $1"
	fi
}

for script in "$root"/scripts/install/*.sh "$root"/scripts/ops/*.sh "$root"/test/deployment/*.sh "$root"/deployments/connectivity-examples/tailscale/*.sh; do
	bash -n "$script"
done

require_line 'VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1' "$env_file"
require_line 'VIDEOCUTLIST_PORT=8787' "$env_file"
require_line 'VIDEOCUTLIST_AUTH_MODE=none' "$env_file"
if grep -Eq '^VIDEOCUTLIST_LISTEN_ADDR=' "$env_file"; then
	fail "legacy combined listener setting remains in the systemd environment"
fi
require_line 'EnvironmentFile=/etc/videocutlist/videocutlist.env' "$unit"
grep -Eq '^After=.*tailscaled|^Wants=.*tailscaled' "$unit" && fail "systemd unit requires tailscaled"

forbid_provider "$installer"
forbid_provider "$verifier"
grep -F 'systemctl enable --now videocutlist' "$installer" >/dev/null || fail "installer does not start VideoCutlist"
grep -F 'client/dist' "$installer" >/dev/null || fail "installer does not stage client/dist"
legacy_client_dir=web
grep -F "$legacy_client_dir/dist" "$installer" >/dev/null && fail "installer stages obsolete client directory"
grep -F '/api/v1/health' "$verifier" >/dev/null || fail "neutral verifier does not check health"
grep -F '/api/v1/ready' "$verifier" >/dev/null || fail "neutral verifier does not check readiness"
grep -F 'systemctl is-active --quiet videocutlist' "$verifier" >/dev/null || fail "neutral verifier does not check VideoCutlist"
grep -F 'ss -ltnH' "$verifier" >/dev/null || fail "neutral verifier does not check its listener"

[[ -x $optional ]] || fail "optional Tailscale helper is missing"
grep -Eq '(^|[^[:alnum:]_])tailscale([[:space:]]|$)' "$optional" || fail "optional helper does not use Tailscale"
grep -Eq '(^|[^[:alnum:]_])serve([[:space:]]|$)' "$optional" || fail "optional helper does not configure Serve"
funnel_calls=$(grep -Eo 'tailscale[[:space:]]+funnel([[:space:]]+[^[:space:];|&)]+)?' "$optional" || true)
if [[ -n $funnel_calls ]] && printf '%s\n' "$funnel_calls" | grep -Ev '^tailscale[[:space:]]+funnel[[:space:]]+status$' >/dev/null; then
	fail "optional helper enables or mutates Funnel"
fi
grep -F 'setup-tailscale-serve.sh' "$installer" "$verifier" >/dev/null && fail "primary path invokes optional helper"

echo "deployment file checks passed"
