# Spec: BTW — Asynchronous Side-Question Extension

### Problem Statement

When working in a pi session, users often have tangential questions ("by the way, what does this function do?") that don't belong in the current conversation context. Asking them inline pollutes the session history, inflates token usage, and derails the current task. Opening a separate terminal to run another pi instance loses all conversation context, forcing the user to re-explain or re-paste context.

### Solution

A `/btw` command that spawns an asynchronous child `pi` process with the full conversation history (via `--fork`), resolves the question independently, and displays the result outside the current session's LLM context and conversation history. The user continues working uninterrupted while the side-question resolves in the background.

### User Stories

1. As a pi user, I want to type `/btw "What does parseConfig do?"` so that I can get an answer without interrupting my current workflow.
2. As a pi user, I want the BTW process to run asynchronously so that I can continue typing prompts in the main session while it works.
3. As a pi user, I want to fire multiple `/btw` calls in quick succession so that I can ask several side questions at once without waiting for each to finish.
4. As a pi user, I want the BTW result to appear outside the conversation stream so that it does not pollute my current session's LLM context.
5. As a pi user, I want the BTW result to never be saved in the session file so that future turns and compactions are unaffected by side questions.
6. As a pi user, I want to see a spinning indicator above the editor while a BTW is running so that I know my question is being processed.
7. As a pi user, I want the spinning indicator to show all running BTW queries so that I can track multiple concurrent side questions.
8. As a pi user, I want a spinning item to disappear from the list when its process completes so that the indicator naturally cleans itself up.
9. As a pi user, I want to run `/btw` with no arguments to open a review view of completed results so that I can read answers at my convenience.
10. As a pi user, I want completed results displayed newest-first so that the most recent answer is immediately visible.
11. As a pi user, I want the most recent result expanded by default and older results collapsed so that I can quickly read the latest answer without scrolling past older ones.
12. As a pi user, I want to expand and collapse individual results in the review view so that I can read older answers on demand.
13. As a pi user, I want to navigate the review view with up/down arrows so that I can move between results efficiently.
14. As a pi user, I want to close the review view with Escape so that I can return to the editor quickly.
15. As a pi user, I want the BTW child process to inherit my current model so that answers are consistent with the quality I expect.
16. As a pi user, I want the BTW child process to be unable to edit or write files so that a side question cannot accidentally mutate my codebase.
17. As a pi user, I want the BTW child process to have access to read-only tools and extension tools (web-search, etc.) so that it can investigate thoroughly without risking mutations.
18. As a pi user, I want the BTW child process to inherit my thinking level so that answers respect my current reasoning depth preference.
19. As a pi user, I want the BTW child process to have the full conversation history so that it can answer contextually informed questions.
20. As a pi user, I want BTW processes to be killed when the session shuts down so that orphan processes don't linger after I exit.
21. As a pi user, I want BTW processes to survive Esc/Ctrl+C in the main session so that cancelling a main-session turn doesn't kill my side questions.
22. As a pi user, I want to see usage stats (tokens, cost) with each BTW result so that I'm aware of what side questions cost.
23. As a pi user, I want to see a collapsed tool trace with each BTW result so that I can verify the answer is grounded in evidence.
24. As a pi user, I want to see errors in the same review view as successful results so that I have a consistent place to check all BTW outcomes.
25. As a pi user, I want error results to show partial tool traces so that I can understand what was attempted before the failure.
26. As a pi user, I want the BTW child process to time out after a reasonable period so that hung processes don't run forever.
27. As a pi user, I want the timeout to be configurable so that I can adjust it for longer-running models or queries.
28. As a pi user, I want `/btw` to work even in ephemeral sessions (no session file) so that I'm not blocked from using the feature.
29. As a pi user, I want the BTW child process to not recursively spawn more BTW processes so that I don't get uncontrolled process proliferation.
30. As a pi user, I want to invoke `/btw` without quotes around the question so that typing a quick side question is frictionless.
31. As a pi user, I want the spinning list widget to show a progress count like `● btw (1/3)` so that I can see at a glance how many queries are pending.
32. As a pi user, I want each spinning item to show the question text so that I can identify which queries are still running.
33. As a pi user, I want the BTW review view to display results in the same visual style as subagent results so that the UI is consistent and familiar.

### Implementation Decisions

**Extension location**: `extensions/btw/` directory with `index.ts` as the entry point. The extension is complex enough to warrant a directory (5 modules, custom UI, process management).

**BTW Spawner module**: Spawns a child `pi` process and parses its JSON event stream. Interface:
- Input: session file path (or null for ephemeral), query string, working directory, timeout, abort signal
- Output: Promise resolving to `{ messages: Message[], exitCode: number, stderr: string, usage: UsageStats, model?: string, stopReason?: string, errorMessage?: string }`
- Spawns: `pi --fork <session> --mode json --exclude-tools edit,write -p "query"` with `PI_BTW_CHILD=1` env var
- For ephemeral sessions: falls back to `pi --mode json --no-session --exclude-tools edit,write -p "query"` (no history)
- Parses `message_end` events for assistant messages and usage data, `tool_result_end` events for tool results
- Kills child process on abort signal or timeout (SIGTERM → 5s grace → SIGKILL)
- Timeout default: 5 minutes, configurable via `settings.json` under `btw.timeoutMs`

**BTW Registry module**: In-memory state for running and completed BTW processes. Interface:
- `addRunning(id, query, childProcess)` → adds to running map
- `complete(id, result)` → moves from running to completed list
- `fail(id, error)` → moves from running to completed list with error state
- `getRunning()` → returns current running entries
- `getCompleted()` → returns completed entries in reverse chronological order
- `killAll()` → kills all running child processes (called on session shutdown)
- `clear()` → resets all state
- Each entry has a unique ID (incrementing counter or short UUID)
- Running entries hold: `{ id, query, childProcess, startedAt }`
- Completed entries hold: `{ id, query, result, completedAt }`

**Spinning List Widget module**: Renders running BTW items above the editor via `ctx.ui.setWidget()`. Interface:
- `render(runningEntries)` → produces widget lines
- Format: header `● btw (completed/total)` with tree-structure indented spinner lines `├─ ⏳ <Question>` / `└─ ⏳ <Question>`
- Updates on every add/complete/fail event
- Clears widget when no running items remain

**BTW Review Component module**: Full-screen `ctx.ui.custom()` view for completed results. Interface:
- Constructor takes completed entries list and theme
- Renders results newest-first
- Most recent result expanded by default (full answer + tool trace + usage stats), older results collapsed (header line only)
- Up/down arrows to move selection highlight
- Enter or Ctrl+O to toggle expand/collapse on selected result
- Escape to close
- Successful result format: `✓ btw: <Question>` / usage line / separator / answer text / tool trace
- Error result format: `✗ btw: <Question>` / usage line / separator / error message / partial tool trace
- Visual style matches subagent extension's collapsed/expanded rendering

**Extension Entry (index.ts)**: Wires all modules together:
- Checks `PI_BTW_CHILD` env var at load time; if set, skips all registration (recursion guard)
- Registers `/btw` command: with args → spawn process; without args → open review view
- Registers `session_shutdown` handler → calls `registry.killAll()`
- On spawn: adds to registry, starts spinning list widget, awaits child process, moves to completed on finish
- Strips surrounding quotes from query args
- Reads timeout from `settings.json` under `btw.timeoutMs`

**Child process invocation**: `pi --fork <session-path> --mode json --exclude-tools edit,write -p "query"` with env `PI_BTW_CHILD=1`. The `--fork` flag creates a new session file cloned from the current one, so the child has full conversation history without modifying the original. The child's writes (if any) go to the forked session file, not the original. The `--exclude-tools` flag prevents the child from using `edit` and `write` tools while preserving read-only built-in tools and all extension tools.

**Ephemeral session fallback**: When `ctx.sessionManager.getSessionFile()` returns null (ephemeral session), the spawner omits `--fork` and uses `--no-session` instead. The child runs with project context but no conversation history. The spinning list and review view work identically; the result simply lacks conversational grounding.

**Result data shape**: Each completed BTW stores:
- Final assistant text (extracted from last assistant message's text content blocks)
- Tool trace (list of `{ toolName, args }` extracted from assistant tool calls)
- Usage stats (aggregated input/output/cacheRead/cacheWrite/cost/turns from all assistant messages)
- Model name and stop reason
- Error state (exit code, error message, stderr) if failed

### Testing Decisions

**What makes a good test**: Tests should verify external behavior — what goes in and what comes out — not implementation details like internal state variables or method call order. For the spawner, this means testing the child process invocation args, env vars, and output parsing. For the registry, this means testing state transitions (add → complete → query). For the widget and review component, this means testing rendered output given specific input states.

**Modules to test**:

- **BTW Spawner**: Test that the correct `pi` command is constructed (args, env vars, `--fork` vs `--no-session`), that JSON event parsing produces correct message/usage structures, that timeout kills the process, that abort signal kills the process. Mock `child_process.spawn` for unit tests; integration test with a real `pi -p "echo hello"` for end-to-end validation.
- **BTW Registry**: Test state transitions: add running → complete → appears in completed list; add running → fail → appears with error; killAll terminates all running processes; clear resets state; getCompleted returns reverse chronological order.
- **Spinning List Widget**: Test rendered lines for 0 running, 1 running, multiple running, and mixed running/completed states. Test that widget clears when all items complete.
- **BTW Review Component**: Test that results render newest-first, most recent expanded, older collapsed. Test navigation state changes on up/down. Test expand/collapse toggle. Test error result rendering vs success result rendering.

**Prior art**: The deep-research extension has tests for its config parser (`config.test.ts`) and state manager (`state-manager.test.ts`) following the same pattern — pure function / class testing with mocked I/O. The subagent extension in the pi examples does not ship tests but its `runSingleAgent` function is structured for testability with injected spawn. We follow the deep-research pattern.

### Out of Scope

- Dismiss/clear individual completed results from the review view (v2)
- Notification on completion (explicitly rejected in design)
- Explicit cancel of a running BTW from the spinning list (v2)
- BTW-specific model or thinking level configuration (inherits from current session)
- Persisting BTW results across sessions (results are ephemeral, cleared on session shutdown)
- BTW results entering the LLM context or session file (explicitly out of scope by design)
- Full subagent-style expanded view with markdown rendering in v1 (collapsed tool trace + final answer is sufficient)

### Further Notes

- The BTW extension is architecturally distinct from the subagent extension despite surface similarities. A BTW is a lightweight fork — it inherits the full conversation history and runs the same model, but has no agent definition, no task directory, no manifest, and no structured output pipeline. It is closer to `ctx.fork()` than to `spawnSubagent()`. See CONTEXT.md "BTW vs Subagent" flagged ambiguity.
- ADR-0006 records the decision to use a child `pi --fork` process instead of an in-process agent session.
- The `--fork` flag creates a new session file cloned from the current one. The child process writes its turn to the forked session file, not the original. This means the original session is completely untouched — no entries, no context pollution.
- The spinning list widget uses `ctx.ui.setWidget()` with placement above the editor (default). The review view uses `ctx.ui.custom()`. Both are TUI-only features; in non-TUI modes, `/btw` should gracefully degrade (e.g., in print mode, log results to stderr or skip).
