#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/bin"
cat > "$stage/bin/npm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'view @byteowlz/oqto-app-sdk@0.3.4 version --fetch-retries=0 --fetch-timeout=10000' ]]
n=0
if [[ -f "$STATE" ]]; then n="$(< "$STATE")"; fi
n=$((n+1)); echo "$n" > "$STATE"
if [[ "$MODE" == immediate || ( "$MODE" == delayed && "$n" -ge 3 ) ]]; then echo 0.3.4; exit 0; fi
if [[ "$MODE" == wrong ]]; then echo 0.3.5; exit 0; fi
exit 1
MOCK
printf '#!/usr/bin/env bash\nexit 0\n' > "$stage/bin/sleep"
chmod +x "$stage/bin/"*
export PATH="$stage/bin:$PATH" STATE="$stage/state"
for MODE in immediate delayed unavailable wrong; do
    export MODE
    rm -f "$STATE"
    bash "$repo/scripts/verify-npm-publication.sh" @byteowlz/oqto-app-sdk 0.3.4 > "$stage/output" 2>&1
    case "$MODE" in
        immediate) [[ "$(< "$STATE")" == 1 ]]; grep -q 'Verified on npm' "$stage/output" ;;
        delayed) [[ "$(< "$STATE")" == 3 ]]; grep -q 'Verified on npm' "$stage/output" ;;
        *) [[ "$(< "$STATE")" == 12 ]]; grep -q 'UNVERIFIED' "$stage/output"; grep -q 'Do not republish' "$stage/output" ;;
    esac
    echo "PASS $MODE"
done
