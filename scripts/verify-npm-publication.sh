#!/usr/bin/env bash
# Read-only verification after npm has accepted a publication. Never republishes.
set -euo pipefail
name="${1:?package name required}"
version="${2:?exact version required}"
for attempt in {1..12}; do
    if observed="$(npm view "${name}@${version}" version --fetch-retries=0 --fetch-timeout=10000 2>/dev/null)" && [[ "$observed" == "$version" ]]; then
        echo "Verified on npm: ${name}@${version}"
        exit 0
    fi
    if (( attempt < 12 )); then sleep 5; fi
done
# The preceding publish succeeded. Registry propagation/processing, access or
# network errors cannot undo that success and must not invite another publish.
echo "Publish was accepted; registry visibility remains UNVERIFIED for ${name}@${version}." >&2
echo "Do not republish. Check npm package status and retry only the read-only lookup:" >&2
printf 'npm view %q version\n' "${name}@${version}" >&2
