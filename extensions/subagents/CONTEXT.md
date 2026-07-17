# Context — pi-subagents

Domain glossary for the `subagent` tool. Use these terms exactly in code, tests,
issues, and design docs; don't drift to synonyms.

## Core concepts

- **Subagent** — a disposable child `pi` process spawned to handle one bounded
  task (scouting, planning, editing, reviewing). Runs in `--mode json` with a
  clean prompt and a defined tool set.
- **Agent definition** — a `.md` file (`name`, frontmatter, body-as-system-prompt)
  under the agents directory describing a subagent *type* (e.g. `scout`, `worker`).
- **Task** — the prompt handed to a subagent for a single run.
- **Progress event** — a typed record of subagent activity, emitted from the
  child's NDJSON stdout: `lifecycle`, `tool`, `thinking`, `usage`, `terminal`.
  The `ProgressEvent` type is the central currency between the stream, the
  workspace, and the feed.
- **Activity feed** — the collapsed / expanded view derived from progress events
  for TUI rendering.
- **Usage** — the four-field token snapshot (`input`, `output`, `cacheRead`,
  `cacheWrite`) carried on progress events and summarized for display.

## The workspace seam

- **Task workspace** — one subagent run's directory, `.pi/subagents/<agentId>/`,
  holding `task.md`, `manifest.json`, `events.jsonl`, `progress.jsonl`,
  `output.md`, `run.log`, `process.json`. Modeled by the **`TaskWorkspace`**
  module, which owns the layout and *every* read/write as a named operation —
  callers never see a path or call `fs`. (Was: file layout leaked as raw path
  literals across the spawner, the registry, and the entrypoint.)
- **Agent id** — the opaque token (UUID-derived) naming a task workspace's
  directory. Exposed by `TaskWorkspace.agentId` (basename of its directory);
  also stored in `manifest.json`. The identity used by `WorkspaceStore.remove`
  and the GC tiebreak.
- **Completed at** — the wall-clock moment a run finished, read as `output.md`
  mtime via `TaskWorkspace.completedAt()`. Pairs with `hasOutput()` ("did it
  finish?") to answer "when did it finish?" — the ordering signal for garbage
  collection. Null only when `hasOutput()` is false.
- **Subagents root** — `.pi/subagents/`, the directory holding every task
  workspace. Modeled by **`WorkspaceStore`**: enumerate (`list`), create,
  `open` an existing workspace, `remove` one, and `gcCompleted` to prune it.
  Distinct from a single task workspace — orphan recovery and garbage
  collection both operate over the *store*, not one workspace.
- **Durable log** — `progress.jsonl`, the append-only on-disk record of progress
  events. Authoritative for post-hoc and **cross-process** reads (orphan
  recovery reads a workspace a dead process wrote).
- **Raw stream log** — `events.jsonl`, a forensic/debugging record of raw child
  NDJSON lines. Used for protocol/parser debugging; **not** read by orphan
  recovery or any production code path. Contrast with the **Durable log**.
- **Live channel** — the in-process path by which `TaskWorkspace.appendEvent`
  delivers events to live `tailEvents` subscribers. **Persist-and-push**: append
  writes the durable log *and* pushes to subscribers; there is no file poll,
  because within one live spawn the same process writes and reads the file.
  `tailEvents` **replays the buffered backlog, then goes live**, so subscribe
  timing can never drop a run's opening events.

## Process lifecycle

- **Subagent run** — the spawn → race (exit / timeout / cancel) → assemble
  sequence for one subagent.
- **Process registry** — the in-memory `Map<agentId, ChildProcess>` plus PID
  liveness (`isPidAlive`) and `process.kill`. A *process* concern only; file
  access flows through the workspace, not the registry.
- **Orphan recovery (reaping)** — on a new spawn, killing and recording leftover
  child processes whose owning parent session has died. Walks the `WorkspaceStore`,
  skips workspaces that already have output, checks PID/parent liveness, kills,
  then records a `terminal` event and an error output through the workspace.
- **Garbage collection (GC)** — on a new spawn, right after reaping, pruning
  completed workspaces from the subagents root so it does not grow unbounded.
  A *store/root* concern, not a process concern: targets only workspaces where
  `hasOutput()` is true (the run finished — normally or reaped), orders them by
  `output.md` mtime, and evicts the oldest beyond a retention limit (default 20).
  Never touches live runs or unreaped orphans — reaping owns those.
