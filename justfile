set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Format, lint, typecheck, test and validate the package (the CI gate).
check:
    bash scripts/test-verify-npm-publication.sh
    pnpm check

# The working tree is never packed. Normal releases are the tag-triggered CI
# workflow; use this only when CI cannot publish (e.g. before the npm trusted
# publisher exists). Prompts for confirmation and npm 2FA.
# Publish package.json's version to npm from a clean checkout of its v<version> tag
npm-publish:
    #!/usr/bin/env bash
    set -euo pipefail
    repo="$(pwd)"
    name="$(node -p 'require("./package.json").name')"
    version="$(node -p 'require("./package.json").version')"
    tag="v${version}"
    if ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
        echo "error: tag ${tag} does not exist; tag and push the release commit first" >&2
        exit 1
    fi
    if npm view "${name}@${version}" version >/dev/null 2>&1; then
        echo "error: ${name}@${version} is already published" >&2
        exit 1
    fi
    npm whoami >/dev/null 2>&1 || { echo "error: not logged in to npm; run: npm login" >&2; exit 1; }
    stage="$(mktemp -d)"
    trap 'git worktree remove --force "${stage}/sdk" >/dev/null 2>&1 || true; rm -rf "${stage}"' EXIT
    git worktree add --quiet --detach "${stage}/sdk" "${tag}"
    cd "${stage}/sdk"
    echo "Publishing ${name}@${version} from ${tag} ($(git rev-parse --short HEAD))"
    pnpm install --frozen-lockfile
    pnpm check
    npm pack --dry-run
    read -rp "Publish ${name}@${version} to npm? [y/N] " answer
    [[ "${answer}" == [yY] ]] || { echo "aborted"; exit 1; }
    # Provenance can only be generated in CI; this manual path publishes without it.
    npm publish --provenance=false --access public
    bash "${repo}/scripts/verify-npm-publication.sh" "$name" "$version"
