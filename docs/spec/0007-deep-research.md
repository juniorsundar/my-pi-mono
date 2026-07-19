# Deep Research

### Problem Statement

The pi coding agent can search the web and spawn subagents, but it cannot conduct sustained, multi-step research on a topic. A single `web_search` call returns at most 20 results; `web_fetch` pulls one page at a time. The existing `researcher` subagent does a single-shot search-and-synthesize pass, but real research requires iteration: search, learn from sources, notice gaps, search again with better queries, verify claims, and synthesize.

Worse, if the main agent attempts this manually across multiple turns, its context window fills with raw search results and full-page fetches, degrading reasoning quality and eventually hitting context limits. There is no mechanism to persist intermediate state to disk and resume with a clean context.

The user runs a local SearXNG instance (configured in `settings.json` under `searxng.url`) and an Ollama instance with the `gemma4:32b` model. They want to use the local model for research subagents to avoid burning paid-provider tokens on search-heavy work.

### Solution

A `deep-research` extension that adds a `/deep-research <query>` command. The command orchestrates a multi-step research iteration using specialized subagents (`r-search`, `r-learn`, `r-gap`, `r-verify`, `r-synth`), depositing all intermediate state to a research directory on disk and clearing the main agent's context between iterations so it always operates with a lean prompt.

Each research iteration follows the cycle: search → learn → notice what is missing → search better → verify → synthesize. The orchestration is driven by the main agent's LLM judgment (not a fixed script), making decisions about which subagent to spawn next and whether gaps are significant enough to warrant another search round.

File-based state at `.pi/deep-research/<topic-slug>/state.md` carries the accumulated knowledge forward across iterations. Per-step subagent outputs are archived in `steps/` for traceability. Context is cleared between iterations via session tree navigation to a loop anchor, ensuring the orchestrator always starts fresh from `state.md`.

Model selection is configurable via `settings.json` under a `deepresearch` key, allowing separate models for orchestration and subagent execution.

### User Stories

1. As a user, I want to type `/deep-research "Why did Rust 2024 change range syntax?"` and receive a thorough, well-sourced synthesis after the research completes, so that I don't have to manually run multiple searches and fetch pages myself.

2. As a user, I want the research to iterate — searching, learning from top sources, identifying gaps, searching again with refined queries, verifying claims, and synthesizing — so that the output is comprehensive rather than surface-level.

3. As a user, I want intermediate research state persisted to disk at `.pi/deep-research/<topic>/state.md`, so that I can inspect progress mid-research and resume if the process is interrupted.

4. As a user, I want each subagent's raw output archived in `.pi/deep-research/<topic>/steps/`, so that I can audit the research trail and understand how conclusions were reached.

5. As a user, I want the orchestrator's context window cleared between iterations, so that long research sessions don't degrade reasoning quality or hit context limits.

6. As a user, I want to configure which models are used for orchestration and for research subagents via `settings.json`, so that I can use a local model (`ollama/gemma4:32b`) for the token-heavy search work and a stronger model for orchestration decisions.

7. As a user, I want the existing `researcher` subagent to remain unchanged, so that quick single-shot research continues to work alongside deep research.

8. As a user, I want the deep-research subagents (`r-search`, `r-learn`, etc.) to be loaded lazily — only when a deep-research command is invoked — so that they don't clutter the subagent tool description or get accidentally invoked during normal agent operation.

9. As a user, I want a clear progress indicator during deep research, so that I know which iteration and which subagent is currently running.

10. As a user, I want deep research to handle the case where a subagent times out or fails, so that one failed step doesn't lose all accumulated research and the orchestrator can recover or report the failure clearly.

11. As a user, I want the final synthesis to include inline source citations, so that I can verify claims and follow up on specific sources.

12. As a user, I want to be able to cancel a running deep-research with Escape, so that I'm not locked into waiting for a long research session to complete.

13. As a maintainer, I want the deep-research extension to reuse the existing `spawnSubagent()` infrastructure from the subagents extension, so that subagent lifecycle, progress tracking, timeout handling, and orphan reaping are handled consistently.

14. As a maintainer, I want the research subagents to use the standard agent definition format (`.md` with YAML frontmatter), so that they integrate with the existing agent definition parser, command builder, and tool description auto-generation.

15. As a user, I want the `/deep-research` command to validate that required settings (`deepresearch` in `settings.json`) are present and provide a clear error message if they're missing, so that misconfiguration is obvious.

### Implementation Decisions

#### Modules

The feature consists of three groups:

- **The deep-research extension** — registers the `/deep-research` command, manages the research directory, orchestrates the iteration loop, and handles context clearing.
- **Five research subagent definitions** — `r-search`, `r-learn`, `r-gap`, `r-verify`, `r-synth` as `.md` files in the agents directory, each with a narrow system prompt and limited tools.
- **Settings schema extension** — a `deepresearch` key in `settings.json` with `orchestratorModel` and `subagentModel`.

##### Extension: `extensions/deep-research/`

The extension entry point registers a `/deep-research` command. The command handler is responsible for the full research lifecycle:

**Research directory management.** On invocation, creates `.pi/deep-research/<slug>/` with an initial `state.md` containing the research question and empty sections (Summary, Findings, Gaps, Next Step). A `steps/` subdirectory holds per-subagent output.

**Iteration loop.** The orchestrator reads `state.md`, decides the next step, spawns the appropriate r-* subagent via the existing `spawnSubagent()`, reads the subagent's output, updates `state.md`, and archives the raw output to `steps/<agent-id>.md`. It then clears context by navigating the session tree to a loop anchor and triggers the next iteration.

**Orchestration model.** v1 uses a hybrid approach: the command handler iterates in a loop, but the decision of which subagent to spawn next is delegated to the main agent via a lightweight prompt at each iteration (read `state.md` → return next action). This gives LLM judgment over the flow while keeping the iteration mechanics in the command handler.

**Context clearing.** A loop anchor entry is created at the start of deep research via `pi.appendEntry()`. After each iteration, the command handler calls `ctx.navigateTree(anchorId)` to drop accumulated context and re-seed with `state.md` content, then sends the next decision prompt via `ctx.sendUserMessage()`.

**Agent definitions loading.** The five r-* agent definition files are placed in a subdirectory (`agents/deep-research/`) rather than the top-level `agents/` directory. The extension registers a custom agents directory for these definitions, keeping them out of the default subagent tool description. When `/deep-research` is invoked, the extension configures the subagent spawner to look in both the default agents directory and the deep-research agents directory.

**Configuration.** A `loadDeepresearchConfig()` helper reads `settings.json` and extracts `deepresearch.orchestratorModel` and `deepresearch.subagentModel`. If the `deepresearch` key is missing, the command fails with a descriptive error. If `subagentModel` is set, all r-* subagents are spawned with that model via the `overrides.model` option in `spawnSubagent()`.

**Cancellation.** The command handler passes the `ctx.signal` (AbortSignal) to `spawnSubagent()`, so pressing Escape cancels the current subagent and the command handler can either retry or abort the research session cleanly.

**Progress reporting.** Each subagent spawn includes an `onProgress` callback that surfaces the r-* agent's activity to the user via the existing subagent progress UI.

**Final output.** When the orchestrator decides research is complete (r-synth has run), the final synthesis is returned as a custom message with `customType: "deep-research-result"`, displayed in the TUI. The research directory remains on disk for later inspection.

##### Subagent Definitions: `agents/deep-research/r-*.md`

Each is a standard agent definition with YAML frontmatter:

- **`r-search`** — Searches the web for a topic. Tools: `web_search`. Takes a search strategy description and returns ranked, annotated results with relevance assessments. Model: `subagentModel` from settings.
- **`r-learn`** — Fetches and extracts key information from specific URLs. Tools: `web_fetch`, `read`, `write`. Takes a list of URLs and a learning objective, returns extracted findings with source citations. Model: `subagentModel` from settings.
- **`r-gap`** — Analyzes the current research state and identifies gaps. Tools: `read`, `write`. Reads `state.md` and the steps archive, returns a structured gap analysis with suggested follow-up search queries. Model: `subagentModel` from settings.
- **`r-verify`** — Cross-references findings for consistency and factual accuracy. Tools: `web_search`, `web_fetch`, `read`, `write`. Takes a set of claims, searches for corroborating or contradicting evidence, returns a verification report. Model: `subagentModel` from settings.
- **`r-synth`** — Produces the final research synthesis. Tools: `read`, `write`. Reads all accumulated state, produces a polished, well-sourced synthesis document. Model: `subagentModel` from settings.

All five have `inheritProjectContext: false` and `inheritSkills: false` since they operate on the research directory, not the user's project.

##### Settings Schema

```json
{
  "deepresearch": {
    "orchestratorModel": "anthropic/claude-sonnet-4-5",
    "subagentModel": "ollama/gemma4:32b"
  }
}
```

- `orchestratorModel` — model used for the lightweight decision prompt at each iteration (which subagent to spawn next). If omitted, the session's current model is used.
- `subagentModel` — model used for all r-* subagents. If omitted, falls back to each subagent's definition model.

#### Key Architectural Decisions

- **Reuse `spawnSubagent()` from the subagents extension.** No new process-spawning code. The deep-research extension imports from the subagents extension or calls the `subagent` tool indirectly.
- **Research subagents are standard agent definitions.** They live in `agents/deep-research/`, have the same YAML frontmatter format as other agents, and are parsed by the existing `parseAgentDefinitionFile()`.
- **Lazy loading via a secondary agents directory.** The extension maintains a separate agents directory path. The subagent tool's description doesn't list deep-research agents. Only when `/deep-research` runs does the command handler construct spawn calls with the deep-research agents directory.
- **File-based state, not in-memory.** `state.md` is the single source of truth. The orchestrator reads it each iteration. Subagent outputs are appended. This makes the system resumable and debuggable.
- **Context clearing via session tree navigation.** `ctx.navigateTree()` drops the conversation after each iteration, keeping the orchestrator's context window small.

#### API Contracts

The deep-research extension does not register new tools — it registers one command (`/deep-research`) and several event handlers (`agent_end` for iteration chaining). It does not expose a programmatic API for other extensions.

The research subagents use only the standard subagent tool interface (`spawnSubagent()`). Their inputs are passed as the `task` string; their outputs are read from `output.md`.

### Testing Decisions

- **Test external behavior only.** Tests should verify the command handler's orchestration logic (research directory creation, state.md updates, step archival, iteration sequencing) without requiring actual subagent execution. Mock `spawnSubagent()` to return canned outputs.
- **Test the config loader.** Verify that valid, missing, and malformed `deepresearch` settings are handled correctly.
- **Test the state manager.** Verify that `state.md` is correctly initialized, updated, and that step outputs are properly archived to `steps/`.
- **Prior art.** The subagents extension has extensive Vitest tests (`spawner.test.ts`, `stream-processor.test.ts`, etc.). The web-search extension has pytest tests (`scripts/tests/`). Follow the Vitest pattern for the extension code and the pytest pattern if any Python scripts are added.
- **Subagent definitions do not need automated tests.** Their behavior emerges from the LLM; testing would require live model calls. Manual smoke tests suffice for v1.

### Out of Scope

- Multiple parallel research topics in a single session
- Customizing the iteration cycle beyond the fixed search→learn→gap→search→verify→synthesize flow
- Per-subagent model overrides (all r-* agents share one model in v1)
- Resuming a partially-complete deep-research from a different session
- Streaming progress for individual subagent steps (uses existing subagent progress UI)
- A `deep_research` tool callable by the LLM (only the `/deep-research` command is implemented)
- Any changes to the existing `researcher` agent type
- Research that modifies project files (deep-research is read-only from the project's perspective)

### Further Notes

The iteration loop design balances two tensions: the user wants the main agent's LLM judgment to drive decisions (not a fixed script), but the command handler needs to manage context clearing and state persistence mechanically. The v1 hybrid approach delegates the "which subagent next?" decision to the main agent in a lightweight prompt at each iteration, while the command handler handles the mechanical loop (file I/O, context navigation, error recovery).

Subagent timeout configuration: the existing `spawnSubagent()` applies timeouts per agent type. The r-* definitions should specify reasonable timeouts (e.g., 120s for r-search and r-learn, 60s for r-gap and r-verify, 120s for r-synth) to prevent hanging on slow sources.

SearXNG dependency: research subagents that use `web_search` depend on a running local SearXNG instance configured in `settings.json` under `searxng.url`, matching the existing web-search extension's dependency.
