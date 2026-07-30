#!/usr/bin/env sh
# Generated fixture recipe for B01. Output files are intentionally gitignored.
set -eu

out=${1:-"$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"}
mkdir -p "$out"
ffmpeg -y -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=1000:sample_rate=48000 -t 1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$out/sample-h264-aac.mp4"
ffmpeg -y -f lavfi -i testsrc2=size=180x320:rate=25 -t 1 -c:v libx264 -pix_fmt yuv420p -an "$out/sample-no-audio.mp4"
