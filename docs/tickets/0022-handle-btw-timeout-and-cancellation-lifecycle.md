# Ticket 0022: Handle BTW timeout and cancellation lifecycle

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Make the BTW Process lifecycle bounded and cancel-safe. Hung side-questions are terminated after the configured timeout, explicit aborts terminate only the targeted BTW Process, and main-session interruption does not accidentally kill running BTW Processes.

### Acceptance criteria

- [x] A BTW Process is terminated when it exceeds the configured timeout
- [x] Timeout termination first requests graceful exit, then force-kills if the process does not exit within the grace period
- [x] Timeout results appear as BTW error results with a clear message
- [x] An explicit abort signal terminates the BTW Process and returns an error result
- [x] Cancelling or interrupting the main-session turn does not terminate unrelated running BTW Processes
- [x] Process listeners and timers are cleaned up after success, failure, timeout, and abort
- [x] Tests cover timeout, force-kill fallback, abort, successful cleanup, and failure cleanup

### Blocked by

- Ticket 0020 — needs the core BTW Process spawning and result parsing path
