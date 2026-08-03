#!/usr/bin/env bash
# A controllable stand-in for cancellation and failure integration tests.
set -euo pipefail

pid_file=${VIDEOCUTLIST_TEST_PID_FILE:-}
child=''
cleanup() {
  test -z "$child" || kill "$child" 2>/dev/null || true
  test -z "$child" || wait "$child" 2>/dev/null || true
  exit 143
}
trap cleanup INT TERM

case ${VIDEOCUTLIST_FAKE_FFMPEG_FAIL:-} in
  corrupt) printf '%s\n' 'invalid media data' >&2; exit 1 ;;
  enospc) printf '%s\n' 'No space left on device' >&2; exit 1 ;;
  permission) printf '%s\n' 'Permission denied' >&2; exit 1 ;;
  '') ;;
  *) echo "unknown VIDEOCUTLIST_FAKE_FFMPEG_FAIL" >&2; exit 2 ;;
esac

sleep 300 &
child=$!
if test -n "$pid_file"; then
  printf '%s %s\n' "$$" "$child" >"$pid_file"
fi
printf '\000\000\000\030ftypisom'
while :; do sleep 1; done
