# `@byteowlz/oqto-app-sdk`

Typed, capability-based interface for sandboxed-web [Oqto](https://github.com/byteowlz/oqto) Apps.

The SDK is intentionally small: apps receive opaque resource refs and granted capabilities over a nonce-bound `MessagePort`. They never receive host paths, Oqto credentials, filesystem mounts, or control sockets.

Sandboxed-web Apps require a **real distinct, non-opaque origin** such as `<definition-hash>.apps.example.com`. The iframe therefore uses `sandbox="allow-scripts allow-same-origin"`; isolation comes from the dedicated hostname, host-only Oqto cookies, CSP, and the capability Bridge. Opaque `null` origins and wildcard `postMessage` targets deliberately fail closed.

## Status

`0.1.0` is the first contract release. The SDK and deterministic test host are implemented; Oqto's live discovery/origin/Gate adapters are tracked separately. Do not mistake a manifest capability request for a live grant.

## Install

This repository is the canonical source. Until byteowlz vendoring is wired, use a pinned workspace or Git dependency:

```json
{
  "dependencies": {
    "@byteowlz/oqto-app-sdk": "link:../oqto-app-sdk"
  }
}
```

## App entry

```ts
import { connectOqtoApp } from "@byteowlz/oqto-app-sdk";

const host = await connectOqtoApp();
const bound = host.context.bound;
if (!bound || !host.files) throw new Error("This app requires a bound document and files grant");

const initial = await host.files.read(bound.ref);
// Render from initial.bytes and retain initial.version for the next write.
```

`connectOqtoApp()` derives the exact parent origin from `document.referrer`, announces readiness, and accepts one nonce-matched `MessagePort`. The host must preserve the iframe document referrer or pass `hostOrigin` explicitly. After that handshake all capability traffic stays on the private port.

## Conflict-safe document write

```ts
const result = await host.files.write(bound.ref, nextBytes, {
  expectedVersion: initial.version,
});

if (!result.ok) {
  // Another writer (for example a backend agent) won. Re-read and apply the
  // app's domain-specific rebase/merge policy.
  const current = await host.files.read(bound.ref);
} else {
  // Keep the returned version for the next write.
  console.log(result.stat.version);
}
```

File identity (`OqtoFileRef`) and freshness (`OqtoFileVersion`) are separate opaque types. Refs are stable and may be stored by the same App Instance, but every reuse is validated against the current binding and grant. Versions are compared only for equality. There is deliberately no unconditional document write in v0.

For a full `FilesSceneStore` shape, see [`examples/files-scene-store`](examples/files-scene-store/files-scene-store.ts).

## Cheap freshness and events

```ts
const stat = await host.files.stat(bound.ref); // no bytes
const unsubscribe = await host.files.watch(bound.ref, ({ version }) => {
  // Events may coalesce to the newest version. Re-read when it differs.
});
```

`stat` is the polling fallback. `watch` is the event-driven path; change events contain no bytes and may coalesce.

## Deterministic tests

```ts
import { createTestHost } from "@byteowlz/oqto-app-sdk/testing";

const test = createTestHost({
  files: [{ id: "scene", label: "diagram.excalidraw", bytes: "{}" }],
  boundFileId: "scene",
});
const host = test.connect(); // real MessageChannel protocol, not a direct fake

const before = await host.files!.read(host.context.bound!.ref);
test.externalWrite("scene", '{"external":true}');

const conflict = await host.files!.write(before.ref, new TextEncoder().encode("{}"), {
  expectedVersion: before.version,
});
console.assert(!conflict.ok);
```

The test host can simulate backend-agent writes, flush coalesced file changes deterministically, change themes, inspect notifications, and disconnect active bridges.

## Host integration

OqtoUI consumes the host subpath:

```ts
import { attachOqtoAppFrame } from "@byteowlz/oqto-app-sdk/host";

const bridge = await attachOqtoAppFrame({
  frameWindow: iframe.contentWindow!,
  appOrigin: installation.appOrigin,
  adapter: grantedAdapter,
});
```

The client exposes only granted capabilities, and the trusted host checks `context.capabilities` again for every raw protocol request. A granted capability without an adapter fails before the handshake. The live adapter remains responsible for identity authorization, binding checks, runner-side Gate calls, atomic storage, and audit records; the SDK also applies conservative request-concurrency and payload ceilings at the Bridge seam.

The owner of the iframe must call `bridge.close()` when the frame unmounts or navigates; DOM removal is not itself a reliable MessagePort liveness signal. A timed-out write is indeterminate: call `stat`, compare versions, and re-read rather than blindly retrying.

## Package modules

- `@byteowlz/oqto-app-sdk`: contracts, errors, theme helper, app-side connection
- `@byteowlz/oqto-app-sdk/host`: host-side frame and MessagePort adapters
- `@byteowlz/oqto-app-sdk/testing`: deterministic in-memory conformance host
- `@byteowlz/oqto-app-sdk/react`: optional provider and hook

## Deferred from v0

Directory traversal, create/delete/rename, range/streaming I/O, cross-file transactions, locks, dynamic rebinding, runtime permission prompts, agent RPC, and WebMCP. These can be additive without weakening the initial document contract.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs formatting, linting, strict typechecking, handshake/protocol/concurrency tests, package build, `publint`, and `arethetypeswrong`.
