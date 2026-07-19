# Ticket 0021: Support ephemeral-session BTW fallback

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Let BTW work in ephemeral sessions where no session file can be forked. A user can still ask a side-question; the BTW Process runs without conversation history, preserves the same safety restrictions, and returns a normal BTW result or error result.

### Acceptance criteria

- [x] BTW detects when there is no session file to fork
- [x] In ephemeral sessions, the BTW Process starts without attempting to fork a session
- [x] Ephemeral BTW Processes still run in JSON mode
- [x] Ephemeral BTW Processes still exclude edit and write tools
- [x] Ephemeral BTW Processes still receive the BTW Child Guard environment flag
- [x] Ephemeral BTW results use the same success and error result shape as forked BTW results
- [x] Tests cover the ephemeral invocation path and verify it does not include a forked session

### Blocked by

- Ticket 0020 — needs the core BTW Process spawning and result parsing path
