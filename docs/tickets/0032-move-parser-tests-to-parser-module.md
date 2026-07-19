# Ticket 0032: Move parser tests to the parser interface

### Parent

Architecture review: `extensions/btw/` deepening opportunity #1.

### What to build

Move parser-focused test coverage from the BTW Process spawning test file into the parser test file. The parser interface is the test surface for NDJSON semantics.

Tests to move or replicate against the parser interface: assistant text extraction from `message_end`, tool trace extraction from `tool_execution_start` / `tool_call`, tool trace deduplication by `toolCallId`, usage accumulation, model and stop-reason extraction, malformed JSON tolerance, and empty-input handling.

Existing spawning test slices that exercise parser output through `spawnBtwProcess` keep running against the spawning interface — they verify the integration, not the parsing rules. The goal is that NDJSON shape changes are caught by parser tests first, not spawning tests.

### Acceptance criteria

- [x] Parser tests exercise: text extraction, tool trace extraction, tool trace dedup, usage accumulation, model extraction, stop-reason extraction, malformed JSON, empty input
- [x] Parser tests call the parser function directly, not through `spawnBtwProcess`
- [x] Spawning tests continue to pass without changes to expected behavior
- [x] `npm test` passes with all tests green

### Blocked by

- Ticket 0031 — needs the parser module to exist before tests can target it
