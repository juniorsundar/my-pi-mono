# ADR for Deep-Research Architecture

### Parent

Spec `0007-deep-research` — Deep Research multi-turn research workflow

### What to build

Write an Architectural Decision Record documenting the key architectural choices in the deep-research extension. The implementation exists already but the decisions are only implicit in the code and Spec. The ADR should capture: (1) why the orchestrator uses a hybrid LLM-judgment + mechanical-loop approach rather than a fully scripted or fully LLM-driven approach, (2) why subagent definitions reside in `agents/deep-research/` rather than the top-level `agents/` directory (lazy loading to keep them out of the subagent tool description), (3) why the extension reuses `spawnSubagent()` from the subagents extension rather than implementing its own process management, and (4) why `deep_research_complete` is a no-op tool that serves as a completion signal rather than parsing state.md for "Status: complete". Follow the existing ADR naming convention (next number: `0005`) and format from `docs/adr/0001-node-spawn-session-manager.md`.

### Acceptance criteria

- [ ] ADR file created at `docs/adr/0005-deep-research-architecture.md`
- [ ] ADR follows the existing format (Context, Decision, Consequences)
- [ ] Covers the four decision areas listed above
- [ ] Uses domain glossary vocabulary from `CONTEXT.md` (Research Iteration, Research State File, Research Subagent, Research Orchestrator, Loop Anchor)
- [ ] References the Spec (`docs/spec/0007-deep-research.md`) and existing implementation files

### Blocked by

None — can start immediately. This is HITL because it requires human review of the architectural narrative.
