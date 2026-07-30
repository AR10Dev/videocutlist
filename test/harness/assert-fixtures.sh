#!/usr/bin/env bash
# Small runnable check for the fixture generator and its corrupt-media case.
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
"$root/test/harness/generate-fixtures.sh" "$tmp"

for fixture in avc-aac.mp4 avc-aac.mkv avc-aac.mov avc-video-only-long-gop.mp4 portrait-avc-aac.mp4 unusual-dimensions-avc-aac.mp4 multi-audio-avc-aac.mkv vfr-avc-video-only.mp4 very-short-avc-aac.mp4 audio-only.wav; do
  ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$tmp/$fixture" >/dev/null
done
test "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$tmp/multi-audio-avc-aac.mkv" | wc -l | tr -d ' ')" = 2
test "$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$tmp/portrait-avc-aac.mp4")" = 180,320
test "$(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=p=0 "$tmp/unusual-dimensions-avc-aac.mp4")" = 318,178
mapfile -t frame_rates < <(ffprobe -v error -select_streams v -show_entries stream=r_frame_rate,avg_frame_rate -of default=nk=1:nw=1 "$tmp/vfr-avc-video-only.mp4")
test "${frame_rates[0]}" != "${frame_rates[1]}"
for fixture in vp9-opus.webm hevc-aac.mkv av1-aac.mkv; do
  test ! -e "$tmp/$fixture" || ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$tmp/$fixture" >/dev/null
done
if ffprobe -v error "$tmp/corrupt-truncated.mp4" >/dev/null 2>&1; then
  echo "corrupt fixture unexpectedly probes successfully" >&2
  exit 1
fi
test -s "$tmp/manifest.json"
test -s "$tmp/fixture-status.tsv"
