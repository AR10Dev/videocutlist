#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT.mp4" >&2
  exit 2
fi

mkdir -p "$(dirname "$1")"
exec ffmpeg -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=320x180:rate=30 \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 2 -map_metadata -1 -c:v libx264 -pix_fmt yuv420p -g 30 -flags:v +bitexact \
  -c:a aac -ac 2 -flags:a +bitexact "$1"
