#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
output=$("$root/test/performance/measure-command.sh" fixture mp4 software-h264-v1 miss -- sh -c 'printf preview')
test "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" = 2
printf '%s\n' "$output" | tail -n 1 | grep -Eq ',0,7,0$'
