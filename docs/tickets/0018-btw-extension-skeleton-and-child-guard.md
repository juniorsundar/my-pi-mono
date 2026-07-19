# Ticket 0018: BTW extension skeleton and child guard

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`
ADR: `docs/adr/0006-btw-child-fork-process.md`

### What to build

Introduce the BTW extension as an inert, safely loadable command surface. A user can invoke `/btw` with or without a quick side-question and receive a clear placeholder response while the rest of the feature is still unimplemented. When the process is itself a BTW Process, the BTW Child Guard prevents the command from registering, so side-questions cannot recursively spawn more side-questions.

### Acceptance criteria

- [x] The BTW extension loads without changing existing pi behavior when unused
- [x] `/btw` is registered in normal sessions
- [x] `/btw` accepts quoted and unquoted question text without crashing
- [x] `/btw` with no arguments is recognized separately from `/btw <question>`
- [x] The extension returns a clear placeholder for unimplemented query and review paths
- [x] The BTW Child Guard disables BTW registration when the child-process environment flag is present
- [x] Tests cover normal registration, guarded registration, no-argument invocation, quoted question text, and unquoted question text

### Blocked by

None - can start immediately
