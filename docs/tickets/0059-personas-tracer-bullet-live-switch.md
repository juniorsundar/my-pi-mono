# Personas tracer bullet: live persona switch via per-turn override

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

The first vertical slice of the personas extension, end to end: the extension package loads under the repo's flat one-package layout, parses **Persona definitions** (`.md`, YAML frontmatter, strict fields) from the **Global persona directory**, and registers the `persona` command. `/persona <name>` makes that persona the **Active persona**: the per-turn agent-start hook returns the append-mode composed system prompt (pi's built-in prompt plus the persona body) for every subsequent turn, and the status line shows the persona. Conversation history is untouched; with no active persona the hook returns nothing and pi behaves exactly as before. Builds the fake-pi extension-entry-point test harness (fake extension API recording registrations, entries, messages, status; scripted UI; injected temp directories) — the one test seam for the whole feature.

### Acceptance criteria

- [ ] The extension loads cleanly when the global persona directory doesn't exist; no persona is active and pi behaves exactly as before
- [ ] A valid persona definition in the global directory can be switched to via `/persona <name>`; the status line shows it
- [ ] While active, every subsequent turn's system prompt is the built-in prompt plus the persona body; prior turns and conversation history are unchanged
- [ ] Switching back is not yet in scope — but with no persona active, the per-turn hook returns nothing (pi's default prompt intact)
- [ ] Frontmatter fields: `name` (required), `description`, `systemPromptMode` recognized; unknown fields produce a parse error
- [ ] The extension factory accepts injected project/global/bundled directories (agentsDir-style options) — this slice wires only the global one
- [ ] All behavior tested through the extension entry point seam: fake extension API, scripted UI, temp directories (prior art: mutation/btw/subagents index tests); no new seams; `npx vitest run` and `npm run typecheck` pass

### Blocked by

None (can start immediately).