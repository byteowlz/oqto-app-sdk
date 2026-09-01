# Oqto App SDK context

`@byteowlz/oqto-app-sdk` is the independently versioned contract between sandboxed-web Oqto Apps and Oqto hosts. Its consumers are workspace Apps outside the Oqto repository; its host adapter is consumed by OqtoUI.

## Domain language

- **App:** workspace-authored source and a validated immutable presentation bundle.
- **Host:** an Oqto placement implementing granted capabilities.
- **Binding:** the durable owner/data scope of one App Instance.
- **Bound resource:** the opaque document resource supplied at mount.
- **Capability:** a small serializable interface granted by the Host. A manifest request is not a grant.
- **Grant snapshot:** what a mount actually received, including resource roles and operation ids.
- **Ref:** opaque stable resource identity inside a binding; never a path.
- **Role:** the App's own semantic name for a granted resource, such as `outputs`.
- **Version:** opaque file freshness token; equality only.
- **Generation:** monotonic per-subscription change sequence; a gap means events coalesced.
- **Operation:** a pinned semantic action the Host runs outside the sandbox on the App's behalf.
- **Presentation Context:** the container an App renders into. Not the browser viewport.
- **Suspension:** immediate withdrawal of a mount's authority.
- **Bridge:** transport adapter. It conveys authority but does not grant it.

## Invariants

- The iframe receives no host path, credential, socket, or Oqto session cookie.
- Every server-affecting operation is rechecked by the live Host/Gate.
- Document writes are atomic and conditional; v0 has no unconditional write.
- Refs and versions are distinct and opaque.
- All core methods are async and structured-clone compatible.
- Core has no UI-framework dependency; React is an optional adapter.
- Runtime metadata comes from the Host context; the SDK does not duplicate `oqto-app.toml`.
- The protocol version is negotiated, and a side that offers nothing is v0. Newer capabilities fail closed on an older mount instead of degrading silently.
- Operation failure is a value; denial, suspension, timeout, and transport failure are exceptions.
- Suspension is immediate and terminal for a mount: pending calls reject, later calls never reach the Host, and subscriptions stop.
- An App can observe that it was suspended but can never request its own grant. Permission decisions stay outside the App frame.
- Apps size against the Presentation Context, never the viewport.
