# Test Command Handler Orchestration

### Parent

Spec `0007-deep-research` — Deep Research multi-turn research workflow

### What to build

Add Vitest tests for the deep-research command handler's orchestration logic in `extensions/deep-research/index.ts`. The command handler currently has no test coverage — only `config.ts` and `state-manager.ts` are tested. Tests should verify the full `/deep-research` command lifecycle: research directory creation, initial `state.md` generation, model switching, the iteration loop (send prompt → wait for idle → check completion → archive step → navigate tree), and the final result message. Mock `spawnSubagent()` (and the ExtensionAPI / command context) so tests run without a live pi runtime or real subagent processes.

### Acceptance criteria

- [x] Unit tests cover the command handler's initialization path (slug creation, directory setup, state.md creation, loop anchor creation)
- [x] Unit tests cover the iteration loop: prompt sending via `sendUserMessage`, `waitForIdle`, state reading, completion detection (both "Status: complete" in state.md and `deep_research_complete` tool call), step archival, and `navigateTree` context clearing
- [x] Unit tests cover the max-iterations guard (10 iterations without completion → warning notification)
- [x] Unit tests cover config validation: missing `deepresearch` key in settings → clear error notification
- [x] `spawnSubagent` is mocked; no real child processes are spawned
- [x] Mock pattern follows the convention established in `extensions/subagents/index.test.ts`
- [x] All existing tests (`config.test.ts`, `state-manager.test.ts`) continue to pass

### Blocked by

None — can start immediately
