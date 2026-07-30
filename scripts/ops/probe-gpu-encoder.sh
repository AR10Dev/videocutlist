#!/usr/bin/env bash
# Does a disposable VAAPI probe. It changes no service configuration.
set -euo pipefail

input=${1:?usage: $0 /path/to/a/short/video}
[[ -r $input ]] || { echo "input is not readable: $input" >&2; exit 1; }
[[ -r /dev/dri/renderD128 ]] || { echo "/dev/dri/renderD128 is not readable" >&2; exit 1; }
output=$(mktemp --suffix=.mp4)
trap 'rm -f "$output"' EXIT
ffmpeg -nostdin -hide_banner -loglevel error -vaapi_device /dev/dri/renderD128 -i "$input" -t 1 \\
  -vf 'format=nv12,hwupload' -c:v h264_vaapi -an -f mp4 "$output"
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=nw=1:nk=1 "$output" | grep -qx h264
echo "VAAPI h264 probe succeeded; apply the GPU drop-in only with a server release that supports VAAPI previews."
