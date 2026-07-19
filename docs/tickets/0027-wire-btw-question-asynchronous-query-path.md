# Ticket 0027: Wire `/btw <question>` asynchronous query path

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Connect the user-facing `/btw <question>` command to the full asynchronous side-question flow. A user can ask one or more side-questions, continue working while they run, see them in the Spinning List, and later find their results in BTW Review without those results entering the current session's conversation context.

### Acceptance criteria

- [x] `/btw <question>` starts a BTW Process without blocking the main session UI
- [x] Multiple `/btw <question>` invocations can run concurrently
- [x] Quoted and unquoted question text both produce the intended query string
- [x] Starting a BTW Process adds it to running BTW entries
- [x] Successful completion moves the BTW entry to completed results
- [x] Failure moves the BTW entry to completed error results
- [x] The Spinning List updates when BTW Processes start and finish
- [x] BTW answers are displayed outside the conversation stream
- [x] BTW answers are not appended to the current session file
- [x] Tests cover starting one query, starting multiple queries, quoted input, unquoted input, success completion, failure completion, Spinning List updates, and no conversation-stream insertion

### Blocked by

- Ticket 0020 — needs BTW Process spawning and result parsing
- Ticket 0022 — needs bounded process lifecycle behavior
- Ticket 0023 — needs BTW registry state
- Ticket 0024 — needs Spinning List rendering
