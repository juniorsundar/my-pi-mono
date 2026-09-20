# Personas full command surface: picker, default, aliases, idle guard

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

The complete `persona` command UX. With no arguments, `/persona` opens a selector listing every available persona with its `description`, plus an always-present "Default — pi's built-in prompt" entry. `off`, `default`, and `none` are aliases that clear the **Active persona**, restoring pi's built-in prompt for subsequent turns and clearing the status line. An unknown name errors with a message listing the available personas. Switching is rejected with a notification while the agent is mid-run — the command waits for idle first.

### Acceptance criteria

- [ ] `/persona` with no args opens a selector containing every resolvable persona (name + description) and the "Default — pi's built-in prompt" entry
- [ ] Selecting a persona switches to it; selecting Default clears the active persona and clears the status line
- [ ] `/persona off`, `/persona default`, and `/persona none` all clear the active persona
- [ ] `/persona <unknown>` notifies the user and lists available persona names
- [ ] Invoking the command while the agent is mid-run does not change the active persona; the user is told the switch was rejected
- [ ] Switching to default leaves subsequent turns on pi's built-in prompt, history untouched
- [ ] All behavior verified through the extension entry point seam with a scripted selector

### Blocked by

0059 — Personas tracer bullet: live persona switch via per-turn override