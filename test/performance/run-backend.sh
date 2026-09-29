#!/usr/bin/env bash
# Launch a disposable production server for API catalog and/or media workflows.
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
mode=${1:-all}
if [[ $# -gt 1 || ($mode != all && $mode != api && $mode != media) ]]; then
  printf 'usage: %s [all|api|media]\n' "$0" >&2
  exit 2
fi

# API catalog measurements must not include the real-media fixture indexed by
# the media suite. Run each family against its own disposable server/database.
if [[ $mode == all ]]; then
  "$0" api
  BENCH_SUPPRESS_HEADER=1 BENCH_APPEND_RESOURCES=1 "$0" media
  exit
fi

for tool in go curl; do
  command -v "$tool" >/dev/null || {
    printf 'missing required tool: %s\n' "$tool" >&2
    exit 1
  }
done

# Optional Linux /proc sidecar. Never mix resource samples into the timing CSV.
resources_file=${BENCH_RESOURCES_FILE:-}
if [[ -n $resources_file ]]; then
  if [[ $resources_file == - || $resources_file == /dev/stdout || $resources_file == /dev/fd/* || $resources_file == /proc/*/fd/* ]]; then
    printf 'BENCH_RESOURCES_FILE must name a regular output path, not stdout\n' >&2
    exit 2
  fi
  if [[ -e $resources_file && ! -f $resources_file ]]; then
    printf 'BENCH_RESOURCES_FILE must name a regular file\n' >&2
    exit 2
  fi
  if [[ -e $resources_file && $resources_file -ef /dev/fd/1 ]]; then
    printf 'BENCH_RESOURCES_FILE must differ from redirected benchmark CSV stdout\n' >&2
    exit 2
  fi
  if [[ $(uname -s) != Linux || ! -r /proc/self/stat || ! -r /proc/self/io ]]; then
    printf 'BENCH_RESOURCES_FILE sampling requires readable Linux /proc/stat and /proc/io; running CSV benchmark without a resource file\n' >&2
    resources_file=''
  fi
fi

token=''
auth_mode=none
expected_state=ready_empty
fixture="$root/test/fixtures/real-media/sintel-trailer.mp4"
if [[ $mode == media ]]; then
  for tool in openssl ffmpeg ffprobe; do
    command -v "$tool" >/dev/null || {
      printf 'missing required tool: %s\n' "$tool" >&2
      exit 1
    }
  done
  (cd "$root" && ./test/harness/acquire-real-media.sh) >&2
  token=$(openssl rand -hex 32)
  auth_mode=bearer
  expected_state=ready_with_media
fi

work=$(mktemp -d)
server_pid=''
sampler_pid=''
cleanup() {
  if [[ -n $sampler_pid ]]; then
    : >"$work/sampler.stop"
    wait "$sampler_pid" 2>/dev/null || true
  fi
  if [[ -n $server_pid ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$work/bench"
if [[ $mode == media ]]; then
  mkdir -p "$work/media"
  cp -- "$fixture" "$work/media/sintel-trailer.mp4"
  export VIDEOCUTLIST_BENCH_TOKEN="$token"
else
  unset VIDEOCUTLIST_BENCH_TOKEN
fi
if [[ $mode == media ]]; then
  roots_json=$(cd "$root" && go run ./test/performance/roots "$work/bench" "$work/media")
else
  roots_json=$(cd "$root" && go run ./test/performance/roots "$work/bench")
fi
: >"$work/server.log"
(
  cd "$root"
  go build -o "$work/videocutlist" ./cmd/videocutlist
)
if [[ $mode == media ]]; then
  (cd "$root" && go build -o "$work/bench-media" ./test/performance/media)
fi
if [[ $mode == api ]]; then
  (cd "$root" && go build -o "$work/bench-api" ./test/performance/api)
fi
VIDEOCUTLIST_DATABASE_PATH="$work/videocutlist.db" \
  VIDEOCUTLIST_CACHE_DIR="$work/cache" \
  VIDEOCUTLIST_EXPORT_DIR="$work/exports" \
  VIDEOCUTLIST_MEDIA_ROOTS_JSON="$roots_json" \
  VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1 VIDEOCUTLIST_PORT=0 \
  VIDEOCUTLIST_AUTH_MODE="$auth_mode" VIDEOCUTLIST_BEARER_TOKEN="$token" \
  "$work/videocutlist" >"$work/server.log" 2>&1 &
server_pid=$!

base=''
ready=false
for ((i = 0; i < 300; i++)); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'benchmark server exited during startup:\n' >&2
    cat "$work/server.log" >&2
    exit 1
  fi
  log=$(<"$work/server.log")
  if [[ -z $base && $log =~ \"listen_addr\":\"(127\.0\.0\.1:[0-9]+)\" ]]; then
    base="http://${BASH_REMATCH[1]}"
  fi
  if [[ -n $base ]]; then
    if [[ $auth_mode == bearer ]]; then
      status=$(curl -fsS --max-time 2 -H "Authorization: Bearer $token" "$base/api/v1/media/status" 2>/dev/null) || status=''
    else
      status=$(curl -fsS --max-time 2 "$base/api/v1/media/status" 2>/dev/null) || status=''
    fi
    if [[ $status == *"\"state\":\"$expected_state\""* ]]; then
      ready=true
      break
    fi
  fi
  sleep 0.1
done
if [[ $ready != true ]]; then
  printf 'benchmark server did not finish initial media scan; see logs:\n' >&2
  cat "$work/server.log" >&2
  exit 1
fi

if [[ -n $resources_file ]]; then
  if [[ ${BENCH_APPEND_RESOURCES:-0} != 1 ]]; then
    printf 'phase,scale,process,cpu_seconds,peak_rss_bytes,read_bytes,write_bytes,sampled_processes\n' >"$resources_file"
  fi
  printf 'Resource sidecar: Linux /proc samples every ~20ms; CPU/I/O are observed deltas, peak RSS is the largest sampled concurrent sum per process class. Short-lived ffmpeg/ffprobe may be missed; missing readings are blank or omitted.\n' >&2
fi

start_resource_sampler() {
  [[ -n $resources_file ]] || return 0
  rm -f -- "$work/sampler.stop" "$work/sampler.ready" "$work/resource-phase.csv"
  bash "$root/test/performance/resources/sample-linux.sh" \
    "$server_pid" "$work/sampler.stop" "$work/sampler.ready" "$work/resource-phase.csv" "$1" "$2" &
  sampler_pid=$!
  for ((i = 0; i < 100; i++)); do
    [[ -e $work/sampler.ready ]] && return 0
    if ! kill -0 "$sampler_pid" 2>/dev/null; then
      wait "$sampler_pid" || true
      sampler_pid=''
      printf 'resource sampler failed before the phase began\n' >&2
      return 1
    fi
    sleep 0.01
  done
  printf 'resource sampler did not become ready\n' >&2
  return 1
}

stop_resource_sampler() {
  [[ -n $sampler_pid ]] || return 0
  : >"$work/sampler.stop"
  local status=0
  wait "$sampler_pid" || status=$?
  sampler_pid=''
  if ((status != 0)); then
    printf 'resource sampler failed (status %d); phase metrics not appended\n' "$status" >&2
    return "$status"
  fi
  cat "$work/resource-phase.csv" >>"$resources_file"
}

run_phase() {
  local phase=$1 scale=$2 status=0
  shift 2
  start_resource_sampler "$phase" "$scale"
  (cd "$root" && "$@") || status=$?
  stop_resource_sampler || return $?
  return "$status"
}

header='scenario,scale,cache,concurrency,samples,p50_ms,p95_ms,p99_ms,throughput_per_s,bytes_per_s,errors'
emitted=${BENCH_SUPPRESS_HEADER:-false}
emit() {
  local line rows=0 status=0
  run_phase "$1" "$2" "${@:3}" >"$work/result.csv" || status=$?
  while IFS= read -r line; do
    if [[ $line == "$header" ]]; then
      if [[ $emitted == false ]]; then
        printf '%s\n' "$header"
        emitted=true
      fi
    else
      printf '%s\n' "$line"
      ((rows += 1))
    fi
  done <"$work/result.csv"
  if ((status != 0)); then
    printf 'benchmark command exited with status %d\n' "$status" >&2
    return "$status"
  fi
  if ((rows == 0)); then
    printf 'benchmark command produced no measurements\n' >&2
    return 1
  fi
}

if [[ $mode == media ]]; then
  emit media_run 0 "$work/bench-media" \
    --base "$base" --fixture "$fixture" --media-root "$work/media" \
    --repeats "${BENCH_MEDIA_REPEATS:-3}" --concurrency "${BENCH_CONCURRENCY:-2}" \
    --asset-cardinality "${BENCH_ASSET_CARDINALITY:-0}" --scan-files "${BENCH_SCAN_FILES:-1}" \
    --export-segment-ms "${BENCH_EXPORT_SEGMENT_MS:-8000}"
fi
if [[ $mode == api ]]; then
  for scale in ${BENCH_API_SCALES:-100 1000 5000}; do
    if [[ ! $scale =~ ^[1-9][0-9]*$ || $scale -gt 10000 ]]; then
      printf 'BENCH_API_SCALES must contain integers from 1 to 10000\n' >&2
      exit 2
    fi
    run_phase api_seed "$scale" "$work/bench-api" seed --db "$work/videocutlist.db" --alias bench --count "$scale"
    emit api_run "$scale" "$work/bench-api" run \
      --base "$base" --db "$work/videocutlist.db" --scale "$scale" \
      --samples "${BENCH_API_SAMPLES:-100}" --concurrency "${BENCH_CONCURRENCY:-2}"
  done
fi
