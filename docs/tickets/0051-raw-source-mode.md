### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

Add `raw: true` as a parameter that bypasses readability extraction and returns the decoded source text (HTML, JSON, etc.) through the same bounded preview and content-artifact pipeline. Raw mode reports `format: "raw"` in the result. It is mutually exclusive with `download: true` — supplying both returns a controlled validation error.

The TypeScript adapter forwards the `raw` parameter to the Python subprocess and formats the result.

### Acceptance criteria

- [x] `raw` appears as an optional boolean parameter in the `web_fetch` tool schema
- [x] When `raw: true`, readability extraction is skipped entirely — decoded source bytes are returned as-is
- [x] Raw output goes through the same preview truncation and content-artifact pipeline as readable output
- [x] The result reports `format: "raw"` when raw mode is active
- [x] `raw: true` with `download: true` returns a validation error before any network request
- [x] `raw: true` ignores the `format` parameter (does not apply Markdown or text conversion)
- [x] The TypeScript adapter forwards `raw` to the Python subprocess and surfaces `format: "raw"` in the tool result
- [x] Python tests cover: raw HTML returned without extraction, raw output truncated with artifact, raw + download validation error, raw ignoring format parameter
- [x] Python CLI tests own raw-mode behavioral coverage; the thin TypeScript adapter forwards parameters and results without requiring a separate TypeScript test harness

### Blocked by

- 0048 — Prefactor: Extract representation pipeline as a deep module
- 0049 — Content artifact persistence and recoverable truncation
