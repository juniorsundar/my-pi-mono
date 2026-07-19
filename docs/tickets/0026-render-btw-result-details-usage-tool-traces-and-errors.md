# Ticket 0026: Render BTW result details, usage, tool traces, and errors

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Make expanded BTW Review entries informative and auditable. Successful results show the answer, usage, and collapsed evidence trace. Failed results appear in the same review flow with clear error information and whatever partial trace is available.

### Acceptance criteria

- [x] Expanded successful BTW results show the question and final assistant answer
- [x] Expanded successful BTW results show usage stats when available
- [x] Expanded successful BTW results show model and stop reason when available
- [x] Successful BTW results include a collapsed tool trace section when tool activity exists
- [x] Expanded error BTW results show the question and clear error message
- [x] Error BTW results show exit or stderr details when available
- [x] Error BTW results include partial tool trace information when available
- [x] Collapsed entries still distinguish success from error status
- [x] Tests cover success rendering, error rendering, missing optional usage fields, collapsed tool traces, and partial traces on failure

### Blocked by

- Ticket 0020 — needs BTW result data from child-process events
- Ticket 0025 — needs the BTW Review rendering surface
