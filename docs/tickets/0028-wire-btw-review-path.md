# Ticket 0028: Wire `/btw` review path

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Connect `/btw` with no arguments to BTW Review. A user can ask side-questions during a session and later run `/btw` to inspect completed success and error outcomes without reintroducing those results into the conversation context.

### Acceptance criteria

- [x] `/btw` with no arguments opens BTW Review instead of starting a new BTW Process
- [x] BTW Review receives completed entries from the registry newest-first
- [x] Completed success results can be opened from the review path
- [x] Completed error results can be opened from the review path
- [x] Opening and closing BTW Review does not append BTW results to the conversation stream
- [x] Running `/btw` when no results exist shows the empty review state
- [x] Tests cover no-argument routing, completed success results, completed error results, empty state, and no conversation-stream insertion

### Blocked by

- Ticket 0025 — needs BTW Review navigation and layout
- Ticket 0026 — needs BTW result detail rendering
