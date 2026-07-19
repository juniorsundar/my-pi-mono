# Ticket 0033: Narrow BTW Process spawning tests to lifecycle behavior

### Parent

Architecture review: `extensions/btw/` deepening opportunity #1.

### What to build

Once parser tests own NDJSON semantics, slim the BTW Process spawning test file so it focuses on lifecycle behavior: args/env construction, spawn failure, timeout, force-kill escalation, abort signal, stderr collection, exit-code mapping, and no-output error.

Spawning tests that currently carry large NDJSON fixtures to verify parsing rules should be reduced to lightweight integration stubs — enough to confirm the parser is called and its output flows through, not enough to re-verify every parsing edge case.

### Acceptance criteria

- [x] Spawning tests focus on args/env, spawn failure, timeout, force-kill, abort, stderr, exit-code, and no-output error
- [x] Spawning tests do not duplicate parser edge-case coverage
- [x] NDJSON fixtures in spawning tests are minimal (verify integration, not parsing rules)
- [x] `npm test` passes with all tests green

### Blocked by

- Ticket 0031 — needs the parser module
- Ticket 0032 — needs parser tests to own the edge cases first
