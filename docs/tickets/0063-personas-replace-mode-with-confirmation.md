# Personas replace mode with one-time confirmation

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

Support the full-takeover **Prompt mode**. A persona definition with `systemPromptMode: replace` uses its body as the custom prompt for subsequent turns — discarding pi's built-in coding-assistant prompt, while pi's project context and skills still attach. Because losing the built-in tool guidance is the dangerous case (and a frontmatter typo can cause it), the first switch to a replace-mode persona in a session asks for confirmation before applying; the user is told the built-in prompt will be replaced. Append mode remains the default and is unaffected.

### Acceptance criteria

- [x] A `replace` persona's per-turn prompt is its body as the custom prompt (project context and skills still attached, built-in prompt absent)
- [x] The first switch to a replace-mode persona in a session asks for confirmation; declining leaves the active persona unchanged
- [x] Confirming once means further replace-mode switches in the same session don't re-confirm
- [x] A new session re-arms the confirmation
- [x] Append-mode personas never trigger a confirmation
- [x] Restoring a replace-mode persona on resume does not re-confirm (session already established it), while a fresh switch within the session still honors the one-time rule
- [x] Composition, confirmation, and decline all verified through the extension entry point seam with a scripted confirm

### Blocked by

0059 — Personas tracer bullet: live persona switch via per-turn override