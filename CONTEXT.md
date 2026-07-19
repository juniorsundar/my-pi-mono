# Pi Agent Context

This context describes the project language for pi agent extensions and workflows.

## Mutation Diff Rendering

The `edit` and `write` tools use a two-state inline rendering lifecycle. Argument streaming may update the partial target path, but it must not progressively generate or reveal diff lines.

### Language

**Pending Summary**:
The single-line inline state shown for an `edit` or `write` call while its arguments are incomplete. It displays the tool name, any currently available partial path, and `preparing diff…`. Its height remains stable, and rendering it performs no file reads, edit validation, or diff generation.
_Avoid_: Streaming diff, loading card, partial preview

**Approval Card**:
The existing compact inline mutation preview shown once an `edit` or `write` call's arguments are complete. Depending on the completed input, it contains the compact diff or the existing binary, unreadable-file, validation, or generation-error outcome. The name describes the component style; the card is rendered for all `edit` and `write` calls, including calls whose policy does not open an approval prompt.
_Avoid_: Full diff (the card may truncate hunks), approval prompt (the prompt is a separate UI interaction)

**Atomic Reveal**:
The single transition from Pending Summary to Approval Card at Pi's `argsComplete` boundary. The Approval Card's contents are prepared and presented as one render rather than accumulated as arguments stream.
_Avoid_: Buffered streaming (no preview work occurs during the pending phase)

### Flagged ambiguities

- **Approval Card vs approval prompt**: The Approval Card is a read-only inline transcript component. The approve/deny/Neovim/expanded-view selector is a separate interaction with an independent lifecycle.
- **Atomic Reveal vs immutable row**: The Pending Summary's partial path may grow as arguments stream. The guarantee is stable one-line height and no preview work, not that every character remains unchanged.

## Subagents

Delegates bounded work from the main pi agent to disposable child agents (scout, worker, planner, etc.). Each subagent is a fresh `pi` process with its own system prompt, tool set, model, and timeout.

### Language

**Subagent**:
A disposable child `pi` process spawned to perform a bounded task, then collected for its output.
_Avoid_: Worker, child process, delegate process (those are agent types, not the generic concept)

**Agent Type**:
A named role (e.g. scout, worker, reviewer) defined by a `.md` file in the agents directory with YAML frontmatter specifying tools, model, system prompt, description, timeout, and inheritance flags.
_Avoid_: Agent class, agent profile

**Agent Definition**:
The `.md` file that declares an agent type's configuration via YAML frontmatter. The body is the system prompt.
_Avoid_: Agent config, agent spec

**Task Directory**:
A per-execution directory at `.pi/subagents/<agent-id>/` containing task.md, manifest.json, output.md, events.jsonl, progress.jsonl, run.log, and process.json.
_Avoid_: Run directory, working directory

**Manifest**:
`manifest.json` in the task directory — records the full `pi` command, environment variables, and agent-id for a specific execution. Written before spawn, read by the wrapper for lifecycle orchestration.
_Avoid_: Task config, run manifest

**Stream Processor**:
A TypeScript module that consumes `pi --mode json` NDJSON stdout, routes events, writes files (events.jsonl, progress.jsonl, output.md, run.log), and delivers progress events to the spawner via callback.
_Avoid_: Event filter, output filter

**Process Registry**:
An in-memory `Map<string, ChildProcess>` tracking live subagents for cancellation, plus per-task-directory `process.json` files (PID, agent-type, start time) for crash recovery.
_Avoid_: Process table, PID map

**Output File**:
`output.md` in the task directory — the authoritative final text from the subagent. Written by the stream processor on `agent_end` (or with an error if the stream truncates).
_Avoid_: Result file, response file

**Progress File**:
`progress.jsonl` in the task directory — NDJSON of lifecycle, tool, assistant_text, terminal, and usage events emitted during execution. Used for live progress UI and post-hoc usage extraction.
_Avoid_: Event log, activity feed

**Agent ID**:
A unique identifier per execution, formatted as `<agent-type>-<8-char-uuid>` (e.g. `scout-a3f1b2c3`). Used for the task directory name and in the process registry.
_Avoid_: Run ID, execution ID

**Orphan Process**:
A `pi` child process whose parent spawner crashed without cleaning up. Detected on startup by scanning task directories for process.json files whose PIDs are still alive. Reaped by the first spawnSubagent call in a new session.
_Avoid_: Zombie, leaked process, stale subagent

**Tool Description**:
The auto-generated description text for the `subagent` tool, built once at extension registration. It iterates all agent definitions in `agents/*.md`, extracts each `description` field from YAML frontmatter, and produces a bullet list of available agent types with their descriptions. Agents without a `description` field are listed by name only.
_Avoid_: Agent list, capability matrix, agent catalog

### Flagged ambiguities

None currently.

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

## BTW

An asynchronous side-question command that spawns a child `pi` process with the full conversation history, resolves the question independently, and displays the result outside the current session's context.

### Language

**BTW**:
A side-question spawned via `/btw "question"` that runs asynchronously in a forked child process. The result is displayed to the user but never enters the current session's LLM context or conversation history.
_Avoid_: Side query, background question, parallel question

**BTW Process**:
The child `pi` process spawned to resolve a BTW. Runs `pi --fork <session> --mode json -p "question"` with `--exclude-tools edit,write` and the `PI_BTW_CHILD=1` environment variable. Inherits the parent's model and thinking level but cannot mutate files.
_Avoid_: BTW agent, BTW subagent (it is not a subagent — it has no agent type or task directory)

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

- **BTW vs Subagent**: A BTW is not a subagent. Subagents have agent types, task directories, manifests, and stream processors. A BTW is a lightweight fork — it inherits the full conversation history and runs the same model, but has no agent definition, no task directory, and no structured output pipeline. It is closer to `ctx.fork()` than to `spawnSubagent()`.
- **BTW Result vs Session Entry**: BTW results are intentionally excluded from the session. They live only in extension memory and the BTW Review view. They do not appear in the conversation stream, the session file, or the LLM context. This is the defining difference from a normal tool result.

## Mutation

A permission and approval boundary around tools that can change files, shell state, or external system state.

### Language

**Mutation Package**:
A single Pi extension package that owns mutation-related policy and approval behavior, including edit/write diff approval, bash approval, and permission profile commands/status.
_Avoid_: Confirm mutating tools, permission profiles package, mutation folder split

**Bash Approval**:
A user decision point for a shell command that may mutate files, shell state, or external system state. It is separate from edit/write diff approval because the thing being approved is a command, not a file content transition.
_Avoid_: Confirm mutating tools, shell gate, bash permission prompt

### Flagged ambiguities

None currently.

### Example dialogue

> **Dev**: I want to deep-research a topic. What happens?
>
> **Domain Expert**: `/deep-research "Why did Rust 2024 change range syntax?"` creates a research directory at `.pi/deep-research/rust-2024-range-syntax/` with an initial `state.md` containing the question. The orchestrator (main agent) reads it, decides to start with `r-search`, spawns it, and appends the search results to `state.md`. It then navigates to the loop anchor, clearing context. Next turn starts fresh: reads `state.md`, sees search results and gaps, decides to spawn `r-learn` to fetch and digest the top sources, appends that, navigates again. This repeats through `r-gap`, another `r-search`, `r-verify`, and finally `r-synth`. At each turn the orchestrator's context is just the system prompt + `state.md` — the accumulated history lives in files, not in context.
>
> **Dev**: What if the orchestrator crashes mid-iteration?
>
> **Domain Expert**: `state.md` and all step outputs in `steps/` are on disk. The user can resume with `/resume` and the orchestrator picks up from the last recorded state. Nothing is lost except the in-flight subagent (which becomes an orphan process and is reaped on next spawn).

### Example dialogue

> **Dev**: I want to spawn a scout subagent — what happens step by step?
>
> **Domain Expert**: spawner.ts generates an agent-id like `scout-a1b2c3d4`, creates a task directory at `.pi/subagents/scout-a1b2c3d4/`, writes task.md and manifest.json, then writes process.json with the PID. It spawns `pi --mode json --no-session ... -p <task>` directly via Node's `spawn`. Stdout is piped through the stream processor which writes events.jsonl, progress.jsonl, and output.md, and calls back with progress events for the live UI. On `agent_end`, output.md gets the final text and the spawner reads it back. On timeout or cancellation, spawner kills the child and the stream processor writes an error to output.md.
>
> **Dev**: What if the main process crashes mid-execution?
>
> **Domain Expert**: The `pi` child's pipes break when the parent dies, so it exits naturally. On next launch, the first `spawnSubagent` call scans existing task directories, checks which PIDs are alive, and kills any still running — those become orphan processes. It writes a termination error to their output.md so the user sees what happened.
