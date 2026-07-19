### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

Extract a representation pipeline as a deep module in the Python fetch core. The pipeline accepts fetched bytes and a representation mode, then returns source metadata, the available representation, a bounded content preview, completeness flags, warnings, and an optional content artifact path. It hides decoding, readability extraction, character truncation, and the distinction between preview and source truncation behind one interface.

All existing `web_fetch` behavior must remain unchanged — this is a pure refactor that creates the seam where content artifacts, raw mode, and GitHub representations will plug in.

### Acceptance criteria

- [x] A new Python module (or class) encapsulates the representation pipeline: bytes in → (metadata, representation, preview, flags) out
- [x] The existing readable extraction (semantic-container-first with readability-lxml fallback, markdownify) is moved behind this interface
- [x] The existing text-mode extraction is moved behind this interface
- [x] The existing character-limit truncation logic is moved behind this interface
- [x] `fetch.py` delegates to the pipeline module instead of inlining extraction and truncation
- [x] All existing `test_fetch.py` tests pass without modification (or with import-path-only changes)
- [x] The pipeline module has its own unit tests covering: encoding detection, readable extraction, text extraction, truncation at the character boundary, and metadata propagation

### Blocked by

None — can start immediately
