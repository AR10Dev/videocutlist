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

has_encoder() {
  grep -Fq " $1 " <<<"$encoders"
}

encoders=$("$ffmpeg_bin" -hide_banner -encoders 2>/dev/null)
require_encoder libx264
require_encoder aac
status_file="$out/fixture-status.tsv"
printf 'name\tstatus\treason\n' >"$status_file"
present() { printf '%s\tpresent\t-\n' "$1" >>"$status_file"; }
skipped() { printf '%s\tskipped\t%s\n' "$1" "$2" >>"$status_file"; }

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
present avc-aac.mp4
present avc-aac.mkv
present avc-aac.mov
"$ffmpeg_bin" "${source_video[@]}" -map 0:v:0 -c:v libx264 -g 120 -pix_fmt yuv420p \
  -an -metadata creation_time=1970-01-01T00:00:00Z "$out/avc-video-only-long-gop.mp4"
present avc-video-only-long-gop.mp4
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=180x320:rate=30 -f lavfi -i sine=frequency=660:sample_rate=48000 \
  -t 2 -map 0:v:0 -map 1:a:0 -threads 1 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time=1970-01-01T00:00:00Z "$out/portrait-avc-aac.mp4"
present portrait-avc-aac.mp4
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=318x178:rate=30 -f lavfi -i sine=frequency=550:sample_rate=48000 \
  -t 2 -map 0:v:0 -map 1:a:0 -threads 1 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time=1970-01-01T00:00:00Z "$out/unusual-dimensions-avc-aac.mp4"
present unusual-dimensions-avc-aac.mp4
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=330:sample_rate=48000 \
  -f lavfi -i sine=frequency=660:sample_rate=48000 -t 2 -map 0:v:0 -map 1:a:0 -map 2:a:0 \
  -threads 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -metadata:s:a:0 language=eng \
  -metadata:s:a:1 language=ita -metadata creation_time=1970-01-01T00:00:00Z "$out/multi-audio-avc-aac.mkv"
present multi-audio-avc-aac.mkv
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=320x180:rate=30 -t 2 -vf "select='if(lt(n,30),not(mod(n,3)),not(mod(n,2)))'" \
  -fps_mode vfr -threads 1 -c:v libx264 -pix_fmt yuv420p -an \
  -metadata creation_time=1970-01-01T00:00:00Z "$out/vfr-avc-video-only.mp4"
present vfr-avc-video-only.mp4
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i testsrc2=size=320x180:rate=30 -f lavfi -i sine=frequency=880:sample_rate=48000 \
  -t 0.1 -map 0:v:0 -map 1:a:0 -threads 1 -c:v libx264 -pix_fmt yuv420p -c:a aac \
  -metadata creation_time=1970-01-01T00:00:00Z "$out/very-short-avc-aac.mp4"
present very-short-avc-aac.mp4
if has_encoder libvpx-vp9 && has_encoder libopus; then
  "$ffmpeg_bin" "${source_video[@]}" -c:v libvpx-vp9 -row-mt 0 -b:v 400k \
    -c:a libopus -metadata creation_time=1970-01-01T00:00:00Z "$out/vp9-opus.webm"
  present vp9-opus.webm
else
  skipped vp9-opus.webm 'libvpx-vp9 and/or libopus unavailable'
fi
if has_encoder libx265; then
  "$ffmpeg_bin" "${source_video[@]}" -c:v libx265 -preset ultrafast -x265-params pools=1:frame-threads=1:log-level=error \
    -c:a aac -metadata creation_time=1970-01-01T00:00:00Z "$out/hevc-aac.mkv"
  present hevc-aac.mkv
else
  skipped hevc-aac.mkv 'libx265 unavailable'
fi
if has_encoder libaom-av1; then
  "$ffmpeg_bin" "${source_video[@]}" -c:v libaom-av1 -cpu-used 8 -crf 40 -b:v 0 \
    -c:a aac -metadata creation_time=1970-01-01T00:00:00Z "$out/av1-aac.mkv"
  present av1-aac.mkv
else
  skipped av1-aac.mkv 'libaom-av1 unavailable'
fi
"$ffmpeg_bin" -hide_banner -loglevel error -y -fflags +bitexact \
  -f lavfi -i sine=frequency=440:sample_rate=48000 -t 2 -c:a pcm_s16le "$out/audio-only.wav"
present audio-only.wav
dd if="$out/avc-aac.mp4" of="$out/corrupt-truncated.mp4" bs=1 count=256 status=none
present corrupt-truncated.mp4

cat >"$out/manifest.json" <<'EOF'
{"generator":"test/harness/generate-fixtures.sh","durationSeconds":2,"statusFile":"fixture-status.tsv"}
EOF

"$ffprobe_bin" -v error -show_entries format=format_name -of default=nk=1:nw=1 "$out/avc-aac.mp4" >/dev/null
