#!/usr/bin/env bash
# Sample the benchmark server and its direct/indirect ffmpeg and ffprobe children.
# Fields are observed deltas, not lifetime totals or a complete accounting of short jobs.
set -euo pipefail

server=$1 stop=$2 ready=$3 output=$4 phase=$5 scale=$6
hz=$(getconf CLK_TCK)
if [[ ! $hz =~ ^[1-9][0-9]*$ ]]; then
  printf 'cannot determine Linux clock ticks per second\n' >&2
  exit 1
fi

declare -A first_cpu=() last_cpu=() first_read=() last_read=() first_write=() last_write=()
declare -A rss_peak=() samples=() read_samples=() write_samples=() process_kind=()

sample() {
  local pid thread raw stat kind key ticks rss line read_bytes='' write_bytes=''
  local -a pending=("$server") children=() fields=()
  local -A visited=() rss_sum=()
  local index=0
  while ((index < ${#pending[@]})); do
    pid=${pending[index]}
    ((index += 1))
    [[ -z ${visited[$pid]:-} ]] || continue
    visited[$pid]=1
    [[ -r /proc/$pid/stat ]] || continue
    { IFS= read -r raw <"/proc/$pid/stat"; } 2>/dev/null || continue
    [[ $raw == *') '* ]] || continue
    stat=${raw##*) }
    read -r -a fields <<<"$stat"
    ((${#fields[@]} >= 20)) || continue
    kind=${raw#*(}
    kind=${kind%%)*}
    if [[ $pid == "$server" ]]; then
      kind=server
    fi
    if [[ $kind == server || $kind == ffmpeg || $kind == ffprobe ]]; then
      key="$kind:$pid:${fields[19]}"
      ticks=$((fields[11] + fields[12]))
      if [[ -z ${first_cpu[$key]+x} ]]; then first_cpu[$key]=$ticks; fi
      last_cpu[$key]=$ticks
      process_kind[$key]=$kind
      samples[$key]=$((${samples[$key]:-0} + 1))
      {
        while IFS= read -r line; do
          if [[ $line =~ ^VmRSS:[[:space:]]+([0-9]+)[[:space:]]+kB ]]; then
            rss=$((BASH_REMATCH[1] * 1024))
            rss_sum[$kind]=$((${rss_sum[$kind]:-0} + rss))
            break
          fi
        done <"/proc/$pid/status"
      } 2>/dev/null || true
      if [[ -r /proc/$pid/io ]]; then
        read_bytes='' write_bytes=''
        {
          while read -r line; do
            if [[ $line =~ ^read_bytes:[[:space:]]+([0-9]+) ]]; then read_bytes=${BASH_REMATCH[1]}; fi
            if [[ $line =~ ^write_bytes:[[:space:]]+([0-9]+) ]]; then write_bytes=${BASH_REMATCH[1]}; fi
          done <"/proc/$pid/io"
        } 2>/dev/null || true
        if [[ -n $read_bytes ]]; then
          if [[ -z ${first_read[$key]+x} ]]; then first_read[$key]=$read_bytes; fi
          last_read[$key]=$read_bytes
          read_samples[$key]=$((${read_samples[$key]:-0} + 1))
        fi
        if [[ -n $write_bytes ]]; then
          if [[ -z ${first_write[$key]+x} ]]; then first_write[$key]=$write_bytes; fi
          last_write[$key]=$write_bytes
          write_samples[$key]=$((${write_samples[$key]:-0} + 1))
        fi
      fi
    fi
    # Children can be started by any Go runtime thread; enumerate all threads.
    for thread in /proc/"$pid"/task/*; do
      [[ -r $thread/children ]] || continue
      children=()
      { read -r -a children <"$thread/children"; } 2>/dev/null || true
      pending+=("${children[@]}")
    done
  done
  for kind in "${!rss_sum[@]}"; do
    if ((rss_sum[$kind] > ${rss_peak[$kind]:-0})); then rss_peak[$kind]=${rss_sum[$kind]}; fi
  done
}

sample
: >"$ready"
while [[ ! -e $stop ]]; do
  sleep 0.02
  sample
done
sample

declare -A total_cpu=() total_read=() total_write=() group_count=() has_cpu=() has_read=() has_write=()
for key in "${!process_kind[@]}"; do
  kind=${process_kind[$key]}
  group_count[$kind]=$((${group_count[$kind]:-0} + 1))
  if ((${samples[$key]} > 1)); then
    total_cpu[$kind]=$((${total_cpu[$kind]:-0} + last_cpu[$key] - first_cpu[$key]))
    has_cpu[$kind]=1
  fi
  if ((${read_samples[$key]:-0} > 1)); then
    total_read[$kind]=$((${total_read[$kind]:-0} + last_read[$key] - first_read[$key]))
    has_read[$kind]=1
  fi
  if ((${write_samples[$key]:-0} > 1)); then
    total_write[$kind]=$((${total_write[$kind]:-0} + last_write[$key] - first_write[$key]))
    has_write[$kind]=1
  fi
done
: >"$output"
for kind in server ffmpeg ffprobe; do
  [[ -n ${group_count[$kind]+x} ]] || continue
  cpu='' read_bytes='' write_bytes=''
  if [[ -n ${has_cpu[$kind]+x} ]]; then
    ticks=${total_cpu[$kind]}
    printf -v cpu '%d.%03d' "$((ticks / hz))" "$(((ticks % hz) * 1000 / hz))"
  fi
  if [[ -n ${has_read[$kind]+x} ]]; then read_bytes=${total_read[$kind]}; fi
  if [[ -n ${has_write[$kind]+x} ]]; then write_bytes=${total_write[$kind]}; fi
  printf '%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$phase" "$scale" "$kind" "$cpu" "${rss_peak[$kind]:-}" "$read_bytes" "$write_bytes" "${group_count[$kind]}" >>"$output"
done
