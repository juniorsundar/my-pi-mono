# Session settings in persona definitions

Labels: ready-for-agent

### Parent

Spec 0013 — Persona Sessions: consult personas as forked herdr sessions

### What to build

Extend the persona definition parser to accept **Session settings**: `model`, `thinking`, `tools` (string or list), `inheritProjectContext`, `inheritSkills`, `inheritExtensions` / `extensions`, `extraArgs`. Validate them strictly like the existing fields. `timeout` and `enabled` stay unknown keys. Map them to pi argv the same way `extensions/subagents/src/herdr.ts` (`loadAgents`, `extraArgs`) does, with `./`/`../` resolved against the definition's directory and `~/` against HOME. Live switching never reads these settings.

### Acceptance criteria

- [x] Each Session setting parses, and a wrong type is a parse error surfaced in the picker
- [x] `timeout` and `enabled` are still rejected as unknown fields
- [x] Argv mapping matches herdr.ts for every field, including relative and `~/` paths in `extraArgs`
- [x] Switching to a persona with Session settings changes only the system prompt (asserted through the per-turn hook)
- [x] README documents the fields as session-only
- [x] `npx vitest run extensions/personas/` and `npm run typecheck` pass

### Blocked by

None (can start immediately).
