# 1. Persist-and-push progress, not file-poll

Date: 2026-06-24
Status: Accepted

## Context

A subagent's progress is recorded in its task workspace as `progress.jsonl` (the
**durable log**) and rendered live in the TUI as the **activity feed**.

The original design coupled these through the filesystem: the parent process
consumed the child's NDJSON stdout, appended each **progress event** to
`progress.jsonl`, and a separate tailer (`tail-progress.ts`, ~130 lines) polled
that same file every 100ms — tracking byte offsets, handling truncation, guarding
TOCTOU — to rebuild the feed.

The topology makes that round-trip unnecessary:

- The **child never writes `progress.jsonl`** — it only emits NDJSON to stdout.
- The **parent** both appends to `progress.jsonl` and polls it back. The events
  it polls off disk are events it already holds in memory.
- The only other writer is orphan recovery, which appends a `terminal` event to
  an *already-dead* workspace that nobody is tailing.

So within one live spawn there is no second process on the other end of the file.
The filesystem was serving as an IPC channel for a conversation the process was
having with itself.

## Decision

The live feed is an **in-process push** with a **durable log** alongside it:

- `TaskWorkspace.appendEvent(e)` writes `e` to the durable log **and** pushes it
  to live `tailEvents` subscribers.
- `tailEvents(signal)` **replays the buffered backlog, then goes live**, so a
  subscriber that attaches after the first append still sees every event
  (matching the old read-from-offset-0 semantics). Subscribe timing cannot drop
  a run's opening events.
- `progress.jsonl` is kept **only** as the durable, append-only record for
  **cross-process** reads — orphan recovery opens a workspace a dead process
  wrote and reconstructs its events from disk.

The polling tailer is removed.

## Consequences

- `tail-progress.ts` and its ~470 lines of offset / truncation / TOCTOU / fake-
  timer tests are deleted; replaced by a handful of synchronous replay-then-live
  ordering tests.
- The 100ms feed latency and the write→poll→read round-trip are gone.
- The in-memory event buffer also serves the **final** feed and usage assembly,
  so the spawner stops re-reading `progress.jsonl` in the happy path (it had read
  it twice — once for the feed, once for usage).
- **Trade-off accepted:** the live channel no longer supports an arbitrary
  external writer/reader. If a future design has the child (or an external
  monitor) write `progress.jsonl` directly, this decision must be revisited — the
  durable log is still on disk, but the *live* path would need a poll again.
- Do not re-propose "collapse the in-memory buffer and the durable log" or "just
  poll the file": the buffer is the live channel, the log is the cross-process
  recovery record, and they serve different readers.
