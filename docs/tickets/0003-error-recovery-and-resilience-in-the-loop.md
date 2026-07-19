# Error Recovery and Resilience in the Iteration Loop

### Parent

Spec `0007-deep-research` — Deep Research multi-turn research workflow

### What to build

Make the deep-research iteration loop resilient to subagent failures and timeouts. Currently the loop has bare `catch {}` blocks in `wasCompleteToolCalled()` and `archiveLatestSubagentOutput()` that silently swallow errors, and `spawnSubagent()` errors in the `execute()` handler propagate unhandled. If a subagent times out or crashes mid-research, the orchestrator should recover gracefully: log the failure to `state.md`, optionally retry once, and continue to the next iteration rather than losing all accumulated research. When `waitForIdle()` returns after an error, the loop should detect the failure, update state with a structured error note, and decide whether to retry or skip to the next subagent type.

### Acceptance criteria

- [x] When a research subagent times out (via `spawnSubagent` timeout or `ctx.signal` abort), the iteration loop catches the error, logs it to `state.md` under a "## Errors" section (agent type, agent ID, error message, timestamp), and continues to the next iteration
- [x] When a subagent returns an empty or malformed output, the loop detects it, logs a warning to `state.md`, and does not crash the research session
- [x] On subagent failure, the loop retries once with the same agent type before giving up and moving on; the retry is recorded in state
- [x] `wasCompleteToolCalled()` logs errors instead of silently swallowing them (at minimum a `console.warn`)
- [x] `archiveLatestSubagentOutput()` logs errors instead of silently swallowing them and returns a structured result indicating success/failure
- [x] After max iterations with persistent failures, state.md is marked with a "## Status\npartial" status and the user is notified via `ctx.ui.notify()` with a clear message about what failed
- [x] All existing and new tests pass

### Blocked by

- 0001-test-command-handler-orchestration (tests must exist before refactoring error handling)
