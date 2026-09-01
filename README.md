# `@byteowlz/oqto-app-sdk`

Typed, capability-based interface for sandboxed-web [Oqto](https://github.com/byteowlz/oqto) Apps.

The SDK is intentionally small: apps receive opaque resource refs and granted capabilities over a nonce-bound `MessagePort`. They never receive host paths, Oqto credentials, filesystem mounts, or control sockets.

Two frame isolation models are supported, and the SDK never assumes either one:

- **Distinct origin** (`<definition-hash>.apps.example.com`) with `sandbox="allow-scripts allow-same-origin"`. Isolation comes from the dedicated hostname, host-only cookies, CSP, and the Bridge. `attachOqtoAppFrame` implements this handshake and requires an exact, non-opaque origin; wildcards and `null` fail closed.
- **Opaque origin** (`srcdoc` with `sandbox="allow-scripts"`, no `allow-same-origin`). The document has no origin of its own, so there is nothing for an origin check to match. A host using this model must create the `MessageChannel` itself and serve it with `serveOqtoAppPort`, delivering the port through its own trusted path rather than through the origin handshake. See [Host integration](#host-integration).

## Status

`0.2.0` adds the negotiated `oqto-app/v1` surface: granted capability snapshots, semantic operations, multi-resource files with gap-aware watchers, presentation context, and immediate suspension. The handshake still announces `oqto-app/v0`, so a 0.1.0 App and a pre-negotiation host interoperate with the newer counterpart unchanged.

Do not mistake a manifest capability request for a live grant. `context.grants` is the decision; the trusted host re-checks every call regardless.

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

## Granted capabilities

`context.grants` is the live decision, not the manifest request. Drive the interface from it:

```ts
for (const resource of host.context.grants.resources) {
  // resource.role is the App's own name ("outputs"); resource.ref is opaque.
  console.log(resource.role, resource.kind, resource.access, resource.watch);
}
for (const operation of host.context.grants.operations) {
  console.log(operation.id, operation.summary);
}
```

On a v0 mount the snapshot degrades to the capability list with empty resource and operation detail, so branch on `host.protocol` if an App must support both.

## Semantic operations

```ts
const result = await host.operations?.invoke("comfy.generate.submit", {
  workflow: "sdxl",
  prompt: "a red bicycle",
});

if (result?.ok) console.log(result.output);
else console.warn(result?.code, result?.message);
```

The App names an operation id and passes JSON. It never sees an executable, argument vector, environment, or endpoint. An operation that ran and failed is a **value**; denial, suspension, timeout, and transport failure are **exceptions**. Pass an `AbortSignal` to cancel.

## Multi-resource files and gap-aware watchers

```ts
const outputs = host.context.grants.resources.find((entry) => entry.role === "outputs");
if (outputs && host.files) {
  const page = await host.files.list(outputs.ref, { limit: 50 });

  await host.files.watchResources([outputs.ref], (change) => {
    if (change.gap) {
      // The host coalesced or dropped events; re-read rather than assuming
      // every intermediate version was observed.
    }
  });
}
```

`generation` is a monotonic per-subscription sequence and `gap` marks a discontinuity. Both are absent on a v0 host, where nothing about completeness can be inferred.

## Presentation context

```ts
const layout = await host.presentation?.get();
// layout.width / layout.height describe the CONTAINER, not the viewport.
await host.presentation?.watch((next) => applyLayout(next.sizeClass, next.safeArea));
```

An App may be mounted in a narrow split pane, a phone-sized sheet, or a fullscreen surface. Sizing against `window.innerWidth` is wrong; size against this and its `sizeClass`, `density`, `safeArea`, and `reducedMotion`.

## Suspension

```ts
host.onSuspended(({ reason }) => renderReadOnlyNotice(reason));
```

A host may withdraw authority mid-mount when a grant is revoked, an Instance is suspended, or an App is uninstalled. Pending calls reject, later calls never reach the host, and subscriptions stop. Regaining access requires a new decision and a fresh mount, so render an explanation rather than retrying.

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

### App-defined Agent Context

Protocol v2 adds `host.agentContext` for ADR-0044. An App can discover its immutable topic/action catalog and publish bounded domain state such as a Gallery selection or current slide:

```ts
const snapshot = await host.agentContext?.publish("gallery.selection", {
  selected_refs: ["image:81", "image:92"],
  primary_ref: "image:92",
});
```

Publishing context updates state only: it never sends a Chat message or wakes a model. Contextual mutation remains a separate semantic action and must name the revision it was based on:

```ts
await host.agentContext?.invokeAction(
  "gallery.selection.clear",
  snapshot?.revision ?? 0,
  null,
);
```

The host validates topics and values against the pinned App Definition, assigns revisions, enforces disclosure and grants, reports watch gaps, and suspends access immediately on revocation. Apps cannot publish platform-owned context or define model instructions.

## Opaque-origin frames

A `srcdoc` frame without `allow-same-origin` reports `event.origin === "null"`, which `attachOqtoAppFrame` rejects on purpose. Serve those frames directly instead, delivering `port2` through a path the host already trusts:

```ts
import { serveOqtoAppPort } from "@byteowlz/oqto-app-sdk/host";

const channel = new MessageChannel();
const bridge = serveOqtoAppPort(grantedAdapter, channel.port1);
frame.contentWindow!.postMessage(connectMessage, "*", [channel.port2]);
```

`"*"` is unavoidable when the receiver has no origin to name, so the host must bind the exchange some other way: transfer exactly one port, accept a reply only from that port, and never reuse it across mounts. The port itself is the capability.

### Withdrawing authority

```ts
bridge.suspend({ reason: "revoked" });
```

Call this the moment a grant is revoked or an Instance is suspended. The bridge releases live subscriptions, refuses in-flight and later requests before they reach the adapter, and notifies the App. Closing the bridge afterwards is optional.

## Package modules

- `@byteowlz/oqto-app-sdk`: contracts, errors, theme helper, app-side connection
- `@byteowlz/oqto-app-sdk/host`: host-side frame and MessagePort adapters
- `@byteowlz/oqto-app-sdk/testing`: deterministic in-memory conformance host
- `@byteowlz/oqto-app-sdk/react`: optional provider and hooks

## Deferred

Create/delete/rename, range/streaming I/O, cross-file transactions, locks, dynamic rebinding, in-frame permission prompts, agent RPC, and WebMCP. Permission decisions stay outside the App frame by design: an App can observe that it was suspended, never request its own grant.

## Development

```sh
pnpm install
pnpm check
```

`pnpm check` runs formatting, linting, strict typechecking, handshake/protocol/negotiation/capability/suspension/React tests, package build, `publint`, and `arethetypeswrong`.
