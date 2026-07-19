# Ticket 0031: Extract BTW stream parser module

### Parent

Architecture review: `extensions/btw/` deepening opportunity #1.

### What to build

Extract NDJSON event-stream parsing out of the BTW Process spawning module into its own leaf module. The parser owns everything needed to turn raw JSON lines from the child `pi` process into structured result data: assistant text extraction from `message_end` events, tool trace deduplication by `toolCallId`, usage accumulation, and model/stop-reason extraction.

BTW Process spawning calls the parser after collecting stdout lines and returns the combined result to the caller. Shared types (`BtwToolTraceEntry`, `BtwUsage`) remain in the existing types module. The parser module re-exports them for direct consumers.

The spawning module continues to own process lifecycle: args/env construction, spawn, timeout, abort, stderr, exit-code mapping. It does not parse NDJSON itself.

### Acceptance criteria

- [x] A dedicated parser module exports a function that accepts NDJSON lines and returns assistant text, tool trace, usage, model, and stop reason
- [x] The spawning module calls the parser instead of containing parsing logic inline
- [x] The parser module has no imports from the spawning module or from `node:child_process`
- [x] The types module remains the source of truth for `BtwToolTraceEntry` and `BtwUsage`
- [x] The parser module re-exports shared types for backward compatibility
- [x] All existing spawning tests pass without modification to expected behavior
- [x] `npm test` passes with all tests green

### Blocked by

None — can start immediately.
