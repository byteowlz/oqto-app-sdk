# Publish the SDK to the public npm registry under `@byteowlz`

Status: Accepted (2026-10-11)

## Context

Every Oqto App is a separate package that depends on `@byteowlz/oqto-app-sdk`.
Those packages are written by agents and users on many hosts: managed
octo-azure accounts, personal machines, macOS, containers, CI. Until now the
dependency resolved through three channels, each fragile:

- **Provisioned `file:` store** (`$OQTO_APP_SDK_HOME`,
  `$HOME/.local/share/oqto/app-sdk`): exists only on managed hosts and writes a
  machine-specific absolute path into each App's `package.json`.
- **`github:byteowlz/oqto-app-sdk#v<version>` fallback**: npm v12 refuses git
  dependencies unless every consumer passes `--allow-git`, and a git install
  runs the package `prepare` build, which needs dev dependencies.
- **Vendoring into `<app>/_sdk/`** (uncommitted experiment): works offline but
  copies a frozen SDK into every App and cannot be updated normally.

The Oqto platform chose the opposite for the base24 design system
(oqto ADR-0017: vendored via `byt`, not npm), because that package has a single
internal consumer in the same workspace. The SDK's situation is the one a
registry exists for: many independent consumers that should resolve an ordinary
semver dependency.

## Decision

1. Publish `@byteowlz/oqto-app-sdk` to the public npm registry (MIT, already
   `publishConfig.access = "public"`). App packages depend on it as
   `"@byteowlz/oqto-app-sdk": "^<major>.<minor>.<patch>"`.
2. Publish only from CI: `.github/workflows/release.yml` runs on a `v*` tag,
   refuses a tag that does not equal `package.json` `version`, runs the full
   `pnpm check`, then `npm publish` with provenance via npm **trusted
   publishing** (GitHub OIDC). No long-lived npm token is stored. Local
   publishing from a working tree is not a supported path, because a dirty
   tree would be packed.
3. The release tag, `package.json` version and CHANGELOG heading stay in sync;
   a tag never moves after publish.
4. The provisioned `file:` store remains supported as the **offline mirror**
   for air-gapped or locked-down hosts. It must carry the same published
   versions, not a divergent build.

## Consequences

- `oqto-app-init` should default to the registry spec and drop the
  `github:` fallback; the store stays an explicit offline override. Whether the
  `_sdk/` vendoring experiment is still needed is decided after that change.
- The exported API is now a public contract. 0.x minor versions may break;
  breaking changes still require a version bump and CHANGELOG entry.
- Provenance proves which workflow and commit built a version. It does not by
  itself establish that the version is safe to run; App bundles remain
  sandboxed and capability-bounded regardless of how they were built.
- First-time setup is manual and once: the first version must be published by
  an `@byteowlz` maintainer (token or interactive login) before npm allows a
  trusted publisher to be attached to the package; afterwards CI publishes.

## Rejected alternatives

- **Keep git dependencies:** blocked by npm v12 defaults and install-time builds.
- **Vendoring as the primary channel:** frozen copies per App, no update path.
- **Private registry:** adds auth friction for every App build with no secret
  to protect; the package is already public on GitHub.
