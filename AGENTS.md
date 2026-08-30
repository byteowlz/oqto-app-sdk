# Oqto App SDK agent guide

- `CONTEXT.md` owns the domain language and non-negotiable invariants.
- Keep the core interface transport-neutral and framework-free; React stays behind `./react`.
- Refs and versions remain distinct opaque tokens; never expose or infer host paths.
- Every document write remains atomic and conditional. Do not add an unconditional write shortcut.
- Capability enforcement belongs in the trusted host adapter; client-side omission is only ergonomics.
- The production handshake requires an exact non-opaque origin and a nonce-bound transferred MessagePort; never accept `*`.
- Public interface changes require contract tests, CHANGELOG updates, and a semver decision.
- Run `pnpm check` before declaring changes complete; warnings are failures.
