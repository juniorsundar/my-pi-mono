# Pi Agent Context

This context describes the project language for pi agent extensions and workflows. Use these terms exactly in code, tests, issues, and design docs; don't drift to synonyms.

## Web Search and Fetch

Finding public web resources and turning a selected resource into content an agent can inspect safely.

### Language

**Fetched document**:
A public web resource together with its source metadata and the representation produced for agent consumption.

**Content preview**:
The bounded portion of the available representation of a **Fetched document** returned directly in a tool result. Preview truncation is recoverable through a **Content artifact**.
_Avoid_: Full content

**Content artifact**:
The complete available representation of a **Fetched document** made available outside the bounded **Content preview**. It has the same representation as the preview and cannot restore source content that was never obtained.
_Avoid_: Raw download, remainder

**Source truncation**:
A condition where a transport or upstream service limit prevents the fetched representation itself from being complete. It is distinct from recoverable preview truncation.
_Avoid_: Preview truncation

**Readable representation**:
A Markdown or plain-text representation of a **Fetched document** with page chrome and non-content markup removed.
_Avoid_: Raw content

**Raw source**:
The decoded response body of a **Fetched document**, before readability extraction or Markdown conversion. Raw source still uses a bounded **Content preview** and a **Content artifact** when its preview is truncated.
_Avoid_: Download

**GitHub resource**:
A repository root, directory tree, or blob file identified by a recognized `github.com` repository, `/tree/`, or `/blob/` URL. A recognized GitHub resource is resolved through GitHub's API rather than interpreted as an ordinary web page.
_Avoid_: GitHub page

**GitHub resolution failure**:
An explicit, immediate failure to resolve a recognized **GitHub resource**, including missing, unauthorized, rate-limited, and oversized resources. It must not silently become an ordinary HTML fetch.
_Avoid_: Empty document

**Partial tree**:
A deterministic, bounded representation of a GitHub repository or directory whose full descendant set was not obtained. A partial tree is marked with **Source truncation** and must not be described as complete.
_Avoid_: Repository tree

### Example dialogue

> **Developer:** The content preview was truncated. Did we preserve the fetched document?
>
> **Domain expert:** Yes. The preview is bounded, and its content artifact contains the complete available representation.
>
> **Developer:** Does that artifact contain the original HTML response?
>
> **Domain expert:** No. It matches the extracted representation used by the preview; raw source is a separate concern.

## Subagents

Delegates bounded work from the main pi agent to disposable child agents (scout, worker, planner, etc.). Each subagent is a fresh `pi` process with its own system prompt, tool set, model, and timeout.

### Core concepts

**Subagent**:
A disposable child `pi` process spawned to perform a bounded task, then collected for its output. Runs in `--mode json` with a clean prompt and a defined tool set.
_Avoid_: Worker, child process, delegate process (those are agent types or implementation details, not the generic concept)

**Agent Type**:
A named role (e.g. scout, worker, reviewer) defined by a `.md` file in the agents directory with YAML frontmatter specifying tools, model, system prompt, description, timeout, and inheritance flags.
_Avoid_: Agent class, agent profile

**Agent Definition**:
The `.md` file that declares an agent type's configuration via YAML frontmatter. The body is the system prompt.
_Avoid_: Agent config, agent spec

**Task**:
The prompt handed to a subagent for a single run.

**Agent id**:
The opaque token (UUID-derived) naming a task workspace's directory. Exposed by `TaskWorkspace.agentId` (basename of its directory); also stored in `manifest.json`. The identity used by `WorkspaceStore.remove` and the GC tiebreak.
_Avoid_: Run ID, execution ID

**Subagent run**:
The spawn → race (exit / timeout / cancel) → assemble sequence for one subagent.

**Progress event**:
A typed record of subagent activity, emitted from the child's NDJSON stdout: `lifecycle`, `tool`, `thinking`, `usage`, `terminal`. The `ProgressEvent` type is the central currency between the stream, the workspace, and the feed.

**Activity feed**:
The collapsed / expanded view derived from progress events for TUI rendering.

**Usage**:
The four-field token snapshot (`input`, `output`, `cacheRead`, `cacheWrite`) carried on progress events and summarized for display.

### The workspace seam

**Task workspace**:
One subagent run's directory, `.pi/subagents/<agentId>/`, holding `task.md`, `manifest.json`, `events.jsonl`, `progress.jsonl`, `output.md`, `run.log`, `process.json`. Modeled by the **`TaskWorkspace`** module, which owns the layout and *every* read/write as a named operation — callers never see a path or call `fs`.
_Avoid_: Task directory, run directory, working directory

**Subagents root**:
`.pi/subagents/`, the directory holding every task workspace. Modeled by **`WorkspaceStore`**: enumerate (`list`), create, `open` an existing workspace, `remove` one, and `gcCompleted` to prune it. Distinct from a single task workspace — orphan recovery and garbage collection both operate over the *store*, not one workspace.

**Manifest**:
`manifest.json` in the task workspace — records the full `pi` command, environment variables, and agent-id for a specific execution. Written before spawn, read by the wrapper for lifecycle orchestration.
_Avoid_: Task config, run manifest

**Output file**:
`output.md` in the task workspace — the authoritative final text from the subagent. Written by the stream processor on `agent_end` (or with an error if the stream truncates).
_Avoid_: Result file, response file

**Completed at**:
The wall-clock moment a run finished, read as `output.md` mtime via `TaskWorkspace.completedAt()`. Pairs with `hasOutput()` ("did it finish?") to answer "when did it finish?" — the ordering signal for garbage collection. Null only when `hasOutput()` is false.

**Durable log**:
`progress.jsonl`, the append-only on-disk record of progress events. Authoritative for post-hoc and **cross-process** reads (orphan recovery reads a workspace a dead process wrote).
_Avoid_: Event log, progress file

**Raw stream log**:
`events.jsonl`, a forensic/debugging record of raw child NDJSON lines. Used for protocol/parser debugging; **not** read by orphan recovery or any production code path. Contrast with the **Durable log**.

**Live channel**:
The in-process path by which `TaskWorkspace.appendEvent` delivers events to live `tailEvents` subscribers. **Persist-and-push**: append writes the durable log *and* pushes to subscribers; there is no file poll, because within one live spawn the same process writes and reads the file. `tailEvents` **replays the buffered backlog, then goes live**, so subscribe timing can never drop a run's opening events.

### Process lifecycle

**Process registry**:
The in-memory `Map<agentId, ChildProcess>` tracking live subagents for cancellation, plus PID liveness (`isPidAlive`) and `process.kill`, and per-workspace `process.json` files (PID, agent type, start time) for crash recovery. A *process* concern only; file access flows through the workspace, not the registry.
_Avoid_: Process table, PID map

**Orphan process**:
A `pi` child process whose parent spawner crashed without cleaning up. Detected on startup by scanning task workspaces for `process.json` files whose PIDs are still alive. Reaped by the first `spawnSubagent` call in a new session.
_Avoid_: Zombie, leaked process, stale subagent

**Orphan recovery (reaping)**:
On a new spawn, killing and recording leftover child processes whose owning parent session has died. Walks the `WorkspaceStore`, skips workspaces that already have output, checks PID/parent liveness, kills, then records a `terminal` event and an error output through the workspace.

**Garbage collection (GC)**:
On a new spawn, right after reaping, pruning completed workspaces from the subagents root so it does not grow unbounded. A *store/root* concern, not a process concern: targets only workspaces where `hasOutput()` is true (the run finished — normally or reaped), orders them by `output.md` mtime, and evicts the oldest beyond a retention limit (default 20). Never touches live runs or unreaped orphans — reaping owns those.

### Extension plumbing

**Stream processor**:
A TypeScript module that consumes `pi --mode json` NDJSON stdout, routes events, writes files (events.jsonl, progress.jsonl, output.md, run.log), and delivers progress events to the spawner via callback.
_Avoid_: Event filter, output filter

**Tool description**:
The auto-generated description text for the `subagent` tool, built once at extension registration. It iterates all agent definitions in `agents/*.md`, extracts each `description` field from YAML frontmatter, and produces a bullet list of available agent types with their descriptions. Agents without a `description` field are listed by name only.
_Avoid_: Agent list, capability matrix, agent catalog

### Flagged ambiguities

- **Task workspace vs task directory**: Unified on **Task workspace**, the `TaskWorkspace` module's term. "Task directory" is an avoided synonym; older docs may still use it.
- **Agent id structure**: The agent id is an opaque token. Do not parse it or rely on any embedded structure (older docs described a `<agent-type>-<8-char-uuid>` format).
- **Durable log vs progress file**: Unified on **Durable log**, the workspace-seam term for `progress.jsonl`. "Progress file" is an avoided synonym; note it was never the same as the **Activity feed** (the TUI view derived from progress events).

### Example dialogue

> **Dev**: I want to spawn a scout subagent — what happens step by step?
>
> **Domain Expert**: spawner.ts generates an agent id, creates a task workspace at `.pi/subagents/<agentId>/`, writes task.md and manifest.json, then writes process.json with the PID. It spawns `pi --mode json --no-session ... -p <task>` directly via Node's `spawn`. Stdout is piped through the stream processor which writes events.jsonl, progress.jsonl, and output.md, and calls back with progress events for the live UI. On `agent_end`, output.md gets the final text and the spawner reads it back. On timeout or cancellation, spawner kills the child and the stream processor writes an error to output.md.
>
> **Dev**: What if the main process crashes mid-execution?
>
> **Domain Expert**: The `pi` child's pipes break when the parent dies, so it exits naturally. On next launch, the first `spawnSubagent` call runs orphan recovery: it walks the workspace store, checks which PIDs are alive, and kills any still running — those were orphan processes. It records a terminal event and an error output through the workspace so the user sees what happened.

## Deep Research

A turn-by-turn research iteration driven by the main agent inside the normal pi conversation loop. Each turn the orchestrator reads a state file, decides the next step, spawns a specialized research subagent, appends results, and clears context before the next turn.

### Language

**Deep Research**:
A multi-turn research workflow where the main agent iteratively spawns specialized subagents to search, learn, identify gaps, verify, and synthesize — all while keeping its own context window lean through file-based state and context navigation.
_Avoid_: Research loop (ambiguous with single-agent loop), background research

**Research Iteration**:
One pass through the deep-research cycle: read state → decide next step → spawn an r-* subagent → append results → navigate context to loop anchor.
_Avoid_: Research turn, research step (those are the components within an iteration)

**Research Directory**:
`.pi/deep-research/<topic-slug>/` — contains `state.md` (the running summary) and a `steps/` archive of per-subagent outputs.
_Avoid_: Research workspace, output dir

**Research State File** (`state.md`):
The accumulated research state: original question, research plan, running summary of findings, known gaps, and the suggested next step. Updated after each subagent completes. The orchestrator reads only this file each iteration.
_Avoid_: Research journal, research notes, scratchpad

**Research Subagent**:
A specialized agent type (`r-plan`, `r-search`, `r-learn`, `r-gap`, `r-verify`, `r-synth`) that performs one discrete step in the research iteration. Each has a narrow system prompt and limited tools.
_Avoid_: Deep-research agent, research worker

**Research Orchestrator**:
The main pi agent when operating in deep-research mode. Each turn it reads `state.md`, decides the next step, spawns the appropriate r-* subagent, updates `state.md`, and navigates to the loop anchor to clear context.
_Avoid_: Research driver, research coordinator

**Loop Anchor**:
A session tree entry that serves as the reset point between iterations. The orchestrator calls `ctx.navigateTree(anchorId)` after each iteration to drop accumulated context and start fresh from `state.md`.
_Avoid_: Reset point, context boundary

**Research Settings**:
The `deepresearch` key in `settings.json` specifying `orchestratorModel` and `subagentModel` (flat for v1).
_Avoid_: Research config, DR config

**Research Plan**:
An immutable decomposition of the research question into areas, initial search angles, and likely hard parts — written by r-plan on iteration 1 and never modified. Gaps and adaptations discovered mid-research go to `## Current Gaps` and `## Next Step` instead.
_Avoid_: Research roadmap, research strategy, research blueprint

### Flagged ambiguities

- **Researcher vs Deep Research**: The existing `researcher` agent type does a single-shot search-and-synthesize. Deep Research is a multi-iteration workflow driven by the main agent. The two coexist; `researcher` is not renamed or deprecated.
- **Research Plan vs Research State**: The Research Plan is the initial scope written once by r-plan. The Research State File (state.md) is the full living document that contains the plan plus findings, gaps, errors, and next steps. The plan is a section within the state, not a separate file.

### Example dialogue

> **Dev**: I want to deep-research a topic. What happens?
>
> **Domain Expert**: `/deep-research "Why did Rust 2024 change range syntax?"` creates a research directory at `.pi/deep-research/rust-2024-range-syntax/` with an initial `state.md` containing the question. The orchestrator (main agent) reads it, decides to start with `r-search`, spawns it, and appends the search results to `state.md`. It then navigates to the loop anchor, clearing context. Next turn starts fresh: reads `state.md`, sees search results and gaps, decides to spawn `r-learn` to fetch and digest the top sources, appends that, navigates again. This repeats through `r-gap`, another `r-search`, `r-verify`, and finally `r-synth`. At each turn the orchestrator's context is just the system prompt + `state.md` — the accumulated history lives in files, not in context.
>
> **Dev**: What if the orchestrator crashes mid-iteration?
>
> **Domain Expert**: `state.md` and all step outputs in `steps/` are on disk. The user can resume with `/resume` and the orchestrator picks up from the last recorded state. Nothing is lost except the in-flight subagent (which becomes an orphan process and is reaped on next spawn).

## BTW

An asynchronous side-question command that spawns a child `pi` process with the full conversation history, resolves the question independently, and displays the result outside the current session's context.

### Language

**BTW**:
A side-question spawned via `/btw "question"` that runs asynchronously in a forked child process. The result is displayed to the user but never enters the current session's LLM context or conversation history.
_Avoid_: Side query, background question, parallel question

**BTW Process**:
The child `pi` process spawned to resolve a BTW. Runs `pi --fork <session> --mode json -p "question"` with `--exclude-tools edit,write` and the `PI_BTW_CHILD=1` environment variable. Inherits the parent's model and thinking level but cannot mutate files.
_Avoid_: BTW agent, BTW subagent (it is not a subagent — it has no agent type or task workspace)

**Spinning List**:
The widget above the editor showing running BTW processes. Displays a header `● btw (N/M)` with indented spinner lines for each active query. Items are removed when their process completes.
_Avoid_: BTW status, running list, progress widget

**BTW Review**:
The full-screen `ctx.ui.custom()` view opened by `/btw` (no args) showing completed BTW results in reverse chronological order. Most recent result is expanded by default; older results are collapsed.
_Avoid_: BTW results panel, BTW history

**BTW Child Guard**:
The `PI_BTW_CHILD=1` environment variable set on BTW processes. The BTW extension checks for this at registration time and skips registering the `/btw` command if present, preventing recursive BTW invocations.
_Avoid_: BTW recursion flag, BTW lock

**BTW Stream Parser**:
The module that turns raw NDJSON lines from a BTW Process stdout into structured result data (assistant text, tool trace, usage, model, stop reason). Consumes the `pi --mode json` output stream and extracts the final answer. Distinct from BTW Process spawning, which owns args, env, timeout, abort, stderr, and exit-code mapping.
_Avoid_: BTW output parser, BTW result parser

### Flagged ambiguities

- **BTW vs Subagent**: A BTW is not a subagent. Subagents have agent types, task workspaces, manifests, and stream processors. A BTW is a lightweight fork — it inherits the full conversation history and runs the same model, but has no agent definition, no task workspace, and no structured output pipeline. It is closer to `ctx.fork()` than to `spawnSubagent()`.
- **BTW Result vs Session Entry**: BTW results are intentionally excluded from the session. They live only in extension memory and the BTW Review view. They do not appear in the conversation stream, the session file, or the LLM context. This is the defining difference from a normal tool result.

## Mutation

A permission and approval boundary around tools that can change files, shell state, or external system state.

### Language

**Mutation Package**:
A single Pi extension package that owns mutation-related policy and approval behavior, including the edit/write guard, bash approval, and permission profile commands/status.
_Avoid_: Confirm mutating tools, permission profiles package, mutation folder split

**Edit/Write Guard**:
The user decision point for `edit` and `write` calls: a focus-grabbing selector offering Approve / Deny / Inspect-Edit in Neovim. Inline tool rendering is Pi's native preview; the package adds no preview UI of its own.
_Avoid_: Approval Card, Pending Summary, Atomic Reveal, diff preview, Expand diff view

**Plain Confirm Fallback**:
The plain text confirmation used when a change cannot be previewed as a diff (binary, unreadable, or unsafe edit validation) or when Neovim is unavailable. No diff is generated in this path.
_Avoid_: Error card, warning card

**Bash Approval**:
A user decision point for a shell command that may mutate files, shell state, or external system state. It is separate from the Edit/Write Guard because the thing being approved is a command, not a file content transition.
_Avoid_: Confirm mutating tools, shell gate, bash permission prompt

### Flagged ambiguities

None currently.
