### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

When the inline content preview is truncated (the available representation exceeds the character limit), write the complete available representation to an ephemeral temporary file and return its path as `contentArtifactPath`. The agent can then inspect omitted content with the read tool.

Introduce `sourceTruncated` as an independent boolean that reports when the representation itself is incomplete due to a transport or upstream-service limit. `truncated` continues to mean "the preview is shorter than the available representation" and is always recoverable through the content artifact.

The TypeScript adapter forwards `contentArtifactPath` and `sourceTruncated` in tool results.

### Acceptance criteria

- [x] When the content preview is truncated, a content artifact file is written containing the complete available representation
- [x] `contentArtifactPath` is present in the result whenever `truncated` is true, and absent when `truncated` is false
- [x] The content artifact uses the same representation format as the preview (Markdown or text)
- [x] `sourceTruncated` is reported independently of `truncated` — both can be true, both can be false, or either alone
- [x] `sourceTruncated: true` is set when a transport or upstream limit prevented the full source from being obtained
- [x] Content artifacts are written to a temporary directory and are ephemeral (no persistent storage or cross-session retention)
- [x] The TypeScript adapter forwards `contentArtifactPath` and `sourceTruncated` in the tool result
- [x] Python tests cover: no truncation (no artifact), preview truncation (artifact written, path returned), source truncation without preview truncation, both truncations simultaneously
- [x] Python response-shape tests own behavioral coverage; the thin TypeScript adapter forwards the fields without requiring a separate TypeScript test harness

### Blocked by

- 0048 — Prefactor: Extract representation pipeline as a deep module
