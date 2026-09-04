#!/usr/bin/env bash
# Downloads the verified natural-media fixture without adding it to Git.
set -euo pipefail

url=${REAL_MEDIA_URL:-https://media.w3.org/2010/05/sintel/trailer.mp4}
destination=${REAL_MEDIA_PATH:-test/fixtures/real-media/sintel-trailer.mp4}
expected_sha256=b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254
expected_size=4372373

for tool in curl sha256sum wc tr; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'real-media fixture command requires %s; install it and retry test/harness/acquire-real-media.sh\n' "$tool" >&2
    exit 1
  }
done

mkdir -p "$(dirname "$destination")"

valid_cache() {
  [[ -f "$destination" ]] || return 1
  [[ "$(wc -c <"$destination" | tr -d '[:space:]')" == "$expected_size" ]] || return 1
  [[ "$(sha256sum "$destination" | cut -d' ' -f1)" == "$expected_sha256" ]]
}

if valid_cache; then
  printf 'real-media fixture cache hit (sha256 %s)\n' "$expected_sha256"
  exit 0
fi

temporary=$(mktemp "${destination}.tmp.XXXXXX")
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

printf 'downloading verified real-media fixture\n'
if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --connect-timeout 10 --max-time "${REAL_MEDIA_MAX_TIME:-120}" \
  --output "$temporary" "$url"; then
  printf 'real-media fixture download failed; run test/harness/acquire-real-media.sh after network access is available\n' >&2
  exit 1
fi

actual_size=$(wc -c <"$temporary" | tr -d '[:space:]')
actual_sha256=$(sha256sum "$temporary" | cut -d' ' -f1)
if [[ "$actual_size" != "$expected_size" || "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'real-media fixture verification failed (expected %s bytes, sha256 %s; got %s bytes, sha256 %s)\n' \
    "$expected_size" "$expected_sha256" "$actual_size" "$actual_sha256" >&2
  exit 1
fi

mv -f -- "$temporary" "$destination"
trap - EXIT
printf 'real-media fixture downloaded and verified (sha256 %s)\n' "$expected_sha256"
