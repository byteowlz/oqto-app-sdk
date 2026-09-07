# Changelog

## 0.3.1 — unreleased

Adds `oqto-app-init`, a dependency-free scaffold bin that creates a publishable
App package (`oqto-app.toml`, presentation source, bundle HTML, offline-friendly
SDK dependency). Resolution order: `--sdk` flag, then `$OQTO_APP_SDK_PATH`, then
the newest version directory under `$OQTO_APP_SDK_HOME` (provisioned by
oqto-usermgr from the oqto-templates pool), then a version-pinned github
fallback. Ships in the package `files` and as the `oqto-app-init` bin so
provisioned stores can scaffold without network access.

## 0.3.0

Adds negotiated `oqto-app/v2` and ADR-0044 Agent Context. App Definitions can expose unfamiliar domain topics through a platform-neutral catalog; Apps can publish, clear, read, and resume watches of bounded context values without injecting Chat messages or waking a model. Contextual mutations are separate revision-bound actions with typed stale-context outcomes. The host remains authoritative for schemas, revisions, authorization, disclosure, reconnect gaps, and revocation. React adds `useOqtoContextTopic`. v0/v1 mounts continue to negotiate and reject v2-only methods explicitly.

## 0.2.0 — unreleased

Adds the `oqto-app/v1` capability surface. The handshake still announces itself
as `oqto-app/v0`, so an App built against 0.1.0 and a host that predates
negotiation keep working against the newer counterpart without changes.

- Negotiated protocol version: the App offers `supportedVersions`, the host
  selects one, and every later frame carries the selected version. A side that
  offers nothing is treated as v0-only.
- Granted capability snapshot (`context.grants`) naming the exact resources and
  operations a mount received, so an App can drive its interface from the live
  decision rather than from its manifest request. A v0 mount degrades to the
  capability list with empty detail.
- `operations` capability: typed semantic invocation with JSON in and out,
  `AbortSignal` cancellation, and operation failure returned as a value while
  transport, authorization, and suspension stay exceptions.
- Multi-resource files: `resources()`, `list()` over collection resources with
  an opaque cursor, and `watchResources()` for one subscription across many
  refs. Change events gained `generation` and `gap`, so a coalesced stream is
  distinguishable from a complete one.
- `presentation` capability: container surface, size, size class, density, safe
  area, and reduced motion, plus live updates. Apps size against the container,
  which is not the browser viewport.
- Immediate suspension: a host may withdraw authority mid-mount. Pending calls
  reject, later calls never reach the host, live subscriptions stop, and the new
  `suspended` error code reports why.
- React bindings gained `useOqtoGrants`, `useOqtoTheme`, `useOqtoPresentation`,
  `useOqtoSuspension`, and `useOqtoOperation`.
- Test host models the new surface: collections, operations with handlers and
  cancellation, presentation updates, revocation, coalesced-change gaps, and
  per-connection protocol selection.

### Breaking

- `OqtoHostContext.grants` is required. Host adapters constructing a context by
  hand must supply it; `createTestHost` and `attachOqtoAppFrame` already do.
- `OqtoFilesCapability` gained `resources`, `list`, and `watchResources`. A
  custom host adapter must implement them, and they may reject with
  `unsupported` on a v0 mount.
- `OqtoHostBridge` gained `protocol` and `suspend`.
- `OqtoHost` gained `protocol`, `suspension`, `isSuspended`, and `onSuspended`.

## 0.1.0 — unreleased

- Initial transport-neutral capability contracts.
- Conflict-safe files capability with opaque refs and versions.
- Non-racy iframe/host handshake over a transferred MessagePort.
- Host-side bridge adapter with trusted-side grant enforcement, bounded requests/payloads/subscriptions, and race-safe teardown.
- Deterministic MessageChannel test host with backend-writer simulation and watcher coalescing.
- Bounded JSON-only KV, read-only theme snapshots/events, and notifications.
- Exact-origin nonce handshake with transferred-port and failure-path cleanup.
- Optional React provider/hook subpath.
