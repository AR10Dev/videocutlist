#!/usr/bin/env bash
# Enforce the production package and connectivity-provider boundaries.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

fail() { echo "architecture check: $*" >&2; exit 1; }

check_imports() {
	local path=$1 file import_path
	while IFS= read -r file; do
		while IFS= read -r import_path; do
			case $path:$import_path in
				domain:editapp/*|domain:net/http|domain:database/sql|domain:os/exec)
					fail "$file imports forbidden $import_path" ;;
				application:editapp/*)
					[[ $import_path == editapp/domain ]] || fail "$file imports $import_path outside domain" ;;
				application:net/http)
					fail "$file imports forbidden net/http" ;;
				protocol:editapp/infrastructure/*)
					fail "$file imports infrastructure $import_path" ;;
				infrastructure:editapp/protocol/*)
					fail "$file imports protocol $import_path" ;;
			esac
		done < <(awk '
			/^import[[:space:]]*\(/ { in_import = 1; next }
			in_import && /^[[:space:]]*\)/ { in_import = 0; next }
			in_import || /^import[[:space:]]+/ {
				if (match($0, /"[^"]+"/)) {
					value = substr($0, RSTART + 1, RLENGTH - 2)
					print value
				}
			}
		' "$file")
	done < <(find "$path" -type f -name '*.go' ! -name '*_test.go' | sort)
}

cd "$root"
for path in domain application protocol infrastructure; do
	check_imports "$path"
done

if grep -RInE --exclude='*_test.go' \
	'tailscale|tailnet|tailscaled|ts\.net|funnel|ngrok|cloudflare[[:space:]-]*tunnel|wireguard' \
	domain application protocol infrastructure cmd client/src >/dev/null; then
	fail "production core contains a connectivity-provider term"
fi

echo "architecture checks passed"
