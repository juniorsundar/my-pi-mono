# Personas session persistence and switch notices

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

Make the **Active persona** survive the session and make every **Persona switch** visible to the model. Switching appends a non-context-visible session entry recording the active persona; the session-start handler restores it, so a resumed session keeps its persona and forked children (BTW) answer under the same persona. Every switch — entering a persona, switching between personas, and returning to default — also injects a context-visible **Switch notice** shaped `Persona switched: <name> — <description>` (or `... default — pi's built-in prompt`), so the model can account for commitments made under a previous persona instead of silently contradicting them. Sessions recorded before this extension existed simply have no persona entry: they resume with no active persona, no migration.

### Acceptance criteria

- [ ] Switching personas appends a persona-state session entry that is not part of the LLM context
- [ ] The session-start handler reads prior entries and restores the active persona (status line reflects it)
- [ ] Resuming a session with an active persona keeps that persona active; resuming an old session without an entry starts with none
- [ ] A forked child session honors the parent's active persona
- [ ] Every persona switch injects a context-visible switch notice naming the new persona and its description
- [ ] Returning to default injects the default-shaped notice and records the cleared state
- [ ] The persona survives compaction (the per-turn override still applies after compacting)
- [ ] The active persona survives a persona → persona → default → persona sequence with the right entry, notice, and status at each step — all verified through the extension entry point seam

### Blocked by

0060 — Personas full command surface: picker, default, aliases, idle guard