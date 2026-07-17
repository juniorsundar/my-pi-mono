# 2. TaskWorkspace / WorkspaceStore split

Date: 2026-06-24
Status: Accepted

## Context

A subagent run's files live in a **task workspace** (`.pi/subagents/<agentId>/`):
`task.md`, `manifest.json`, `events.jsonl`, `progress.jsonl`, `output.md`,
`run.log`, `process.json`. This is a named concept in the README but had **no
module**. Its layout leaked as raw path literals across two modules — `spawner`
(12 `join(taskDir, …)` calls, plus 2 root-computation literals) and
`process-registry` (5 `join(taskDir, …)` calls, plus 1 directory-walk literal) —
20 path literals in all. The entrypoint touches none. Understanding the workspace
meant reading two files.

Orphan recovery complicates a naive "one module per workspace" fix: `reapOrphans`
walks **sibling** task dirs created by *other, now-dead* processes — reading
`process.json`, checking `output.md`, appending a `terminal` event to
`progress.jsonl`. A module that models only the current spawn's own directory
cannot absorb those cross-directory accesses, so the registry kept its literals.

"One task directory" and "the directory of all task directories" are two concepts
the code had collapsed into one.

## Decision

Split them into two modules, and reduce the registry to a process concern:

- **`TaskWorkspace`** — owns *one* task directory. Operations interface only
  (`writeTask`, `writeManifest`, `appendEvent`, `readProgressEvents`,
  `tailEvents`, `writeOutput`, `readOutput`, `hasOutput`, `writeProcessInfo`,
  `readProcessInfo`, `log`); callers never see a path or call `fs`. Owns the typed
  `ProgressEvent` parse/validate boundary and the live channel (see ADR-0001). A
  static `TaskWorkspace.open(dir)` reconstructs an instance over an
  **existing** directory (throws if missing or not a directory). A `get directory()`
  getter exposes the absolute path for use in manifest metadata.
- **`WorkspaceStore`** — owns the **subagents root** (`.pi/subagents/`):
  `create(agentId)`, `open(agentId)`, `list()`. Orphan recovery walks
  `store.list()` and works through each workspace's operations — no literals.
- **`process-registry`** — reduced to the in-memory `Map<agentId, ChildProcess>`
  plus PID liveness (`isPidAlive`) and `process.kill`. PID/kill is a process
  concern and stays here; all file access flows through the workspace.
  `register(agentId, child)` drops the `taskDir` parameter — the spawner writes
  `process.json` via `TaskWorkspace.writeProcessInfo`. `reapOrphans(store)` is a
  free function in the registry that takes a `WorkspaceStore`, walks
  `store.list()`, and uses each `TaskWorkspace`'s operations for file reads/writes.
  Dependency direction stays registry → store (process control needs files, not
  the reverse).

## Consequences

- The ~20 scattered path literals collapse to `TaskWorkspace.#path()` and
  `WorkspaceStore`'s root path. Spawner and process-registry no longer compute
  file paths; the only path construction outside the workspace modules is the
  `WorkspaceStore` root (`join(workDir, ".pi", "subagents")`) in spawner bootstrap.
- `TaskWorkspace.directory` provides the workspace dir for manifest metadata —
  spawner writes `manifest.taskDir` as `ws.directory` instead of recomputing it.
- Reaping reads as domain logic: "for each workspace in the store, if it has no
  output and its process is dead, kill and record" — no path joins.
- `TaskWorkspace` is **fs-backed** for durability (every write goes to disk via
  `writeFileSync` / `appendFileSync`), with an in-memory event buffer powering
  the live channel (`tailEvents`). The test suite uses real temp directories
  throughout; there is no in-memory-only mode.
- Spawner tests verify workspace state through `WorkspaceStore.open()` + public
  read methods (`readTask`, `readManifest`, `readRawEvents`, `readLog`), not raw
  file paths. The only raw-path operation left in tests simulates out-of-band
  disk mutation by a *different* process, which inherently requires direct I/O.
- `buildCommand()` drops its unused `manifestPath` parameter — it is a pure
  command-building function with no awareness of workspace layout.
- **Cohesion guard:** do not move PID liveness / `process.kill` into the workspace
  or store — those modules own *files and layout*, not OS process control. Keep
  the seam at "workspace mediates file access; registry mediates process control."
