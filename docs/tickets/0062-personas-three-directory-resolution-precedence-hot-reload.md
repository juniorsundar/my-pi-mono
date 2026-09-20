# Personas three-directory resolution, precedence, hot reload

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

Full **Persona definition** discovery. Definitions resolve from the **Project persona directory** (`.pi/personas/` under the project root), the **Global persona directory** (`~/.pi/agent/personas/`), and **Bundled personas** shipped inside the extension package — with precedence on name collision: project over global, global over bundled. Definitions are re-read from disk on every `persona` command invocation (listing and switching), never per turn, so the authoring loop is edit → re-run `/persona <name>` with no session restart. The composed prompt for the active persona is cached in the extension so turns never touch the disk.

### Acceptance criteria

- [x] Personas are discovered from all three directories and listed in the picker
- [x] A same-named project persona shadows the global one; a same-named global persona shadows the bundled one; each shadowing is observable in the composed prompt actually applied
- [x] Editing a persona definition file mid-session applies on the next switch to it (hot reload); no restart required
- [x] Per-turn system prompt application never re-reads definitions from disk (composed prompt cached while active)
- [x] Missing directories (any of the three) are tolerated silently
- [x] The project persona directory resolves relative to the session's working directory
- [x] Precedence and hot reload verified through the extension entry point seam with injected temp directories

### Blocked by

0059 — Personas tracer bullet: live persona switch via per-turn override