#!/usr/bin/env bash
# Emits one CSV record. The command is passed after --; no baseline threshold is implied.
set -euo pipefail

if test $# -lt 6 || test "$5" != --; then
  echo 'usage: measure-command.sh SCENARIO SOURCE_FORMAT ENCODER_PROFILE CACHE_STATE -- COMMAND [ARG...]' >&2
  exit 2
fi
scenario=$1 source_format=$2 encoder_profile=$3 cache_state=$4
shift 5
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start_ns=$(date +%s%N)
set +e
"$@" >"$tmp/stdout" 2>"$tmp/stderr"
status=$?
set -e
end_ns=$(date +%s%N)
wall_ms=$(( (end_ns - start_ns) / 1000000 ))
printf 'started_utc,scenario,source_format,encoder_profile,cache_state,wall_ms,exit_status,stdout_bytes,stderr_bytes\n'
printf '%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$started" "$scenario" "$source_format" "$encoder_profile" "$cache_state" "$wall_ms" "$status" "$(wc -c <"$tmp/stdout" | tr -d ' ')" "$(wc -c <"$tmp/stderr" | tr -d ' ')"
exit "$status"
