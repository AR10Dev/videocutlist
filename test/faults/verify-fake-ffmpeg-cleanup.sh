#!/usr/bin/env bash
# Verifies that the process-cleanup fixture itself exposes and clears its child.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
pid_file=$(mktemp)
trap 'rm -f "$pid_file"' EXIT
VIDEOCUTLIST_TEST_PID_FILE=$pid_file "$root/test/harness/fake-ffmpeg.sh" >/dev/null 2>&1 &
parent=$!
for _ in $(seq 1 50); do test -s "$pid_file" && break; sleep 0.02; done
test -s "$pid_file"
read -r recorded_parent child <"$pid_file"
test "$parent" = "$recorded_parent"
kill -TERM "$parent"
wait "$parent" || test $? -eq 143
if kill -0 "$child" 2>/dev/null; then
  echo "fake ffmpeg child survived termination: $child" >&2
  exit 1
fi
