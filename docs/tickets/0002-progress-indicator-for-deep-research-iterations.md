# Progress Indicator for Deep-Research Iterations

### Parent

Spec `0007-deep-research` — Deep Research multi-turn research workflow

### What to build

Add a visible progress indicator to the deep-research command so the user knows which iteration and which subagent type is currently running. The iteration loop in `index.ts` currently uses `ctx.ui.notify()` for start and completion messages but shows nothing during each subagent's execution. Build on the existing subagent progress callback (`onProgress` in `spawnSubagent`) and the iteration counter to surface a clear, updating indicator: which iteration number (out of max), which r-* agent type is running, and elapsed time. Display via the existing `onUpdate` mechanism in the `spawn_research_subagent` tool's `execute()` handler, and also surface iteration-level progress via `ctx.ui.notify()` at each loop boundary.

### Acceptance criteria

- [x] Before each iteration, the user sees a notification like "Deep research: iteration 3/10" via `ctx.ui.notify()` — NOTE: agent type intentionally omitted (LLM-decided at runtime, not pre-known); surfaces via onProgress prefix and post-iteration summary instead
- [x] During subagent execution, the existing `onProgress` callback surfaces the r-* agent's activity to the TUI — `[r-search]` prefix added to feed text in `spawn_research_subagent` tool's `onUpdate`
- [x] After each iteration completes, a brief summary notification is shown ("Iteration N complete: <agent-type> archived" for non-completing; "Deep research complete (N iterations)" for the final completing iteration)
- [x] The progress indicator works end-to-end when running `/deep-research` — no dead UI during long subagent runs (pre-iteration → onProgress → post-iteration → navigate)
- [x] Existing tests continue to pass — 42 tests across 3 test files, 0 failures

### Blocked by

None — can start immediately
