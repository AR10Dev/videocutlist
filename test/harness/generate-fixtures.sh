#!/usr/bin/env bash
# Generates disposable, deterministic media fixtures. Do not commit its output.
set -euo pipefail

out=${1:?usage: generate-fixtures.sh OUTPUT_DIRECTORY}
ffmpeg_bin=${FFMPEG_BIN:-ffmpeg}
ffprobe_bin=${FFPROBE_BIN:-ffprobe}
mkdir -p "$out"

require_encoder() {
  local encoders
  encoders=$("$ffmpeg_bin" -hide_banner -encoders 2>/dev/null)
  grep -Fq " $1 " <<<"$encoders" || {
    echo "required FFmpeg encoder unavailable: $1" >&2
    exit 1
  }
}

require_encoder libx264
require_encoder aac
require_encoder libvpx-vp9
require_encoder libopus

source_video=(
  -hide_banner -loglevel error -y -fflags +bitexact
  -f lavfi -i testsrc2=size=320x180:rate=30
  -f lavfi -i sine=frequency=880:sample_rate=48000
  -t 2 -map 0:v:0 -map 1:a:0 -threads 1
)

make_h264() {
  local path=$1
  "$ffmpeg_bin" "${source_video[@]}" -c:v libx264 -g 60 -pix_fmt yuv420p \
    -c:a aac -ac 2 -metadata creation_time=1970-01-01T00:00:00Z "$path"
}

make_h264 "$out/avc-aac.mp4"
make_h264 "$out/avc-aac.mkv"
make_h264 "$out/avc-aac.mov"
"$ffmpeg_bin" "${source_video[@]}" -map 0:v:0 -c:v libx264 -g 120 -pix_fmt yuv420p \
  -an -metadata creation_time=1970-01-01T00:00:00Z "$out/avc-video-only-long-gop.mp4"
"$ffmpeg_bin" "${source_video[@]}" -c:v libvpx-vp9 -row-mt 0 -b:v 400k \
  -c:a libopus -metadata creation_time=1970-01-01T00:00:00Z "$out/vp9-opus.webm"
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:a pcm_s16le "$out/audio-only.wav"
dd if="$out/avc-aac.mp4" of="$out/corrupt-truncated.mp4" bs=1 count=256 status=none

cat >"$out/manifest.json" <<'EOF'
{"generator":"test/harness/generate-fixtures.sh","durationSeconds":2,"fixtures":[{"name":"avc-aac.mp4","container":"mp4","video":"h264","audio":"aac"},{"name":"avc-aac.mkv","container":"matroska","video":"h264","audio":"aac"},{"name":"avc-aac.mov","container":"mov","video":"h264","audio":"aac"},{"name":"avc-video-only-long-gop.mp4","container":"mp4","video":"h264","audio":null},{"name":"vp9-opus.webm","container":"webm","video":"vp9","audio":"opus"},{"name":"audio-only.wav","container":"wav","video":null,"audio":"pcm_s16le"},{"name":"corrupt-truncated.mp4","container":"invalid","video":null,"audio":null}]}
EOF

"$ffprobe_bin" -v error -show_entries format=format_name -of default=nk=1:nw=1 "$out/avc-aac.mp4" >/dev/null
