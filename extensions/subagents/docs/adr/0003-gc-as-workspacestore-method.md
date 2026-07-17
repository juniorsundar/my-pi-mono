# 3. Garbage collection as a `WorkspaceStore` method, not a free function

Date: 2026-07-06
Status: Accepted

## Context

The subagents root (`.pi/subagents/`) grows unbounded: every spawned subagent
leaves a task workspace directory on disk, and nothing reclaims it. We added
**garbage collection (GC)** — on every spawn, right after `reapOrphans`, prune
completed workspaces beyond a retention limit (default 20), ordered by
`output.md` mtime (`TaskWorkspace.completedAt()`).

The question was *where* the GC function lives. The existing cross-workspace
operation, `reapOrphans`, is a **free function in `process-registry`** that takes
a `WorkspaceStore` and walks `store.list()`. That placement is justified in
ADR-0002: reaping is a *process concern* (PID liveness, `process.kill`) that
merely *needs* files, so it lives in the registry and reaches into the store.

GC is categorically different. It has no process involvement at all — no PID
checks, no signals. It is purely a *store/root* concern: "this root has too many
completed workspaces, prune some." Putting it in `process-registry` would be a
category error (process module reaching into the store for a non-process reason)
and would invert the ADR-0002 dependency direction.

Two clean homes were considered:

- **Method on `WorkspaceStore`** — `store.gcCompleted(retain)`, backed by a new
  `store.remove(agentId)`. Cohesive with the store's existing `create`/`open`/
  `list` ownership of the root.
- **New sibling module** (`src/workspace-gc.ts`) exporting
  `gcCompletedWorkspaces(store, retain)` — mirrors the `reapOrphans`-as-free-
  function shape, keeps `WorkspaceStore` to enumerate/create/open only.

## Decision

GC is a **method on `WorkspaceStore`**: `gcCompleted(retain: number)`, backed by
`remove(agentId)` (recursive, same `assertSafeAgentId` path-traversal guard as
`create`/`open`). The spawner calls `store.gcCompleted(GC_RETAIN)` immediately
after `registry.reapOrphans(store)`.

The asymmetry with `reapOrphans` is intentional and follows the concern split
established in ADR-0002: reaping is a process concern that *uses* the store, so
it is a free function in the registry; GC is a store concern, so it is a method
on the store. The shared shape — "walk `store.list()`, act per workspace" —
does not imply a shared *home*, because the two operations belong to different
concerns.

The store takes a **required** `retain` parameter (no default); the spawner owns
the policy value as the `GC_RETAIN` constant alongside `TIMEOUT_DEFAULTS`. The
store provides *mechanism* (enumerate, order, evict); the spawner provides
*policy* (how many to retain, when to run). This mirrors how reaping already
works — `reapOrphans` is mechanism, the spawner decides when to call it.

## Consequences

- `WorkspaceStore` gains a second responsibility (eviction policy) alongside
  enumerate/create/open/remove. The policy is ~15 lines: filter `hasOutput()`,
  sort by `completedAt()` (null = oldest) with `agentId` ascending as a stable
  tiebreak, evict the head beyond `retain` via `remove(agentId)`. The only
  sensible policy for this root today; a second caller with different policy is
  not in scope.
- The asymmetry with `reapOrphans` is a documented surprise — a future reader
  will ask why two cross-workspace operations are shaped differently. This ADR
  is the answer: concern split, not oversight.
- A future size-gate or age-fallback policy is easy to add inside the method
  without restructuring; a free function would have ended up calling store
  primitives (`list`, `remove`) anyway, so the method form forecloses nothing.
- `TaskWorkspace` gains two read-only accessors to support GC without path
  literals leaking into the store: `agentId` (basename of its directory) and
  `completedAt()` (`output.md` mtime). Both follow the ADR-0002 seam — the
  workspace owns its layout, callers never see a path.