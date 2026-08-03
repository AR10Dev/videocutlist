#!/usr/bin/env bash
# Read-only deployment checks. Run as root to inspect all systemd state.
set -euo pipefail

command -v curl >/dev/null || { echo "missing curl" >&2; exit 1; }
env_file=${VIDEOCUTLIST_VERIFY_ENV_FILE:-/etc/videocutlist/videocutlist.env}
case $env_file in
  /*) ;;
  *) echo "VIDEOCUTLIST_VERIFY_ENV_FILE must be an absolute path" >&2; exit 1 ;;
esac
[[ -f $env_file && -r $env_file ]] || { echo "missing $env_file" >&2; exit 1; }

setting() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1
}

listen_address=$(setting VIDEOCUTLIST_LISTEN_ADDRESS)
port=$(setting VIDEOCUTLIST_PORT)
listen_address=${listen_address:-127.0.0.1}
port=${port:-8787}
case $listen_address in
  *:*) url_host="[$listen_address]"; listener="[$listen_address]:$port" ;;
  *) url_host=$listen_address; listener="$listen_address:$port" ;;
esac
base_url="http://$url_host:$port"

curl --fail --silent --show-error "$base_url/api/v1/health" >/dev/null
curl --fail --silent --show-error "$base_url/api/v1/ready" >/dev/null
systemctl is-active --quiet videocutlist
ss -ltnH "sport = :$port" | awk -v listener="$listener" '$4 == listener { found=1 } END { exit !found }' || {
  echo "VideoCutlist is not listening on configured $listener" >&2
  exit 1
}
echo "VideoCutlist health, readiness, service state, and configured listener verified."
