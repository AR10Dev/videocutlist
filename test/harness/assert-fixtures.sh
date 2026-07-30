#!/usr/bin/env bash
# Small runnable check for the fixture generator and its corrupt-media case.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$root/test/harness/generate-fixtures.sh" "$tmp"

for fixture in avc-aac.mp4 avc-aac.mkv avc-aac.mov avc-video-only-long-gop.mp4 vp9-opus.webm audio-only.wav; do
  ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$tmp/$fixture" >/dev/null
done
if ffprobe -v error "$tmp/corrupt-truncated.mp4" >/dev/null 2>&1; then
  echo "corrupt fixture unexpectedly probes successfully" >&2
  exit 1
fi
test -s "$tmp/manifest.json"
