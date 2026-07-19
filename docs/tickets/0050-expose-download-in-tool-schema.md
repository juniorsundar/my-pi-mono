### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

Promote the `download` parameter from description-only to a formally declared boolean in the `web_fetch` tool's JSON schema. The parameter already works internally — this ticket makes it visible to model tool-use so it can be invoked reliably.

Existing download behavior (image/PDF content-type allowlists, byte ceilings, temporary file metadata) remains unchanged.

### Acceptance criteria

- [x] `download` appears as an optional boolean parameter in the `web_fetch` tool schema registered by the TypeScript adapter
- [x] The parameter description matches the existing documented behavior (save binary files like images and PDFs to a local temp path)
- [x] Existing download tests continue to pass
- [x] A TypeScript adapter test verifies `download` is present in the registered tool schema

### Blocked by

None — can start immediately
