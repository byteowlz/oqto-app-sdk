# Oqto App SDK context

`@byteowlz/oqto-app-sdk` is the independently versioned contract between sandboxed-web Oqto Apps and Oqto hosts. Its consumers are workspace Apps outside the Oqto repository; its host adapter is consumed by OqtoUI.

## Domain language

- **App:** workspace-authored source and a validated immutable presentation bundle.
- **Host:** an Oqto placement implementing granted capabilities.
- **Binding:** the durable owner/data scope of one App Instance.
- **Bound resource:** the opaque document resource supplied at mount.
- **Capability:** a small serializable interface granted by the Host. A manifest request is not a grant.
- **Ref:** opaque stable resource identity inside a binding; never a path.
- **Version:** opaque file freshness token; equality only.
- **Bridge:** transport adapter. It conveys authority but does not grant it.

## Invariants

- The iframe receives no host path, credential, socket, or Oqto session cookie.
- Every server-affecting operation is rechecked by the live Host/Gate.
- Document writes are atomic and conditional; v0 has no unconditional write.
- Refs and versions are distinct and opaque.
- All core methods are async and structured-clone compatible.
- Core has no UI-framework dependency; React is an optional adapter.
- Runtime metadata comes from the Host context; the SDK does not duplicate `oqto-app.toml`.
