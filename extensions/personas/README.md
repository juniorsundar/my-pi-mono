# Personas Package

Live-switchable Personas for the pi coding agent's main agent: switch the Active persona via `/persona` and the system prompt changes for subsequent turns, while conversation history, model, thinking level, and tools stay untouched. A session with no persona active uses pi's built-in prompt.

## Overview

- `/persona` — opens a picker listing every persona plus the "Default — pi's built-in prompt" entry.
- `/persona <name>` — switches directly.
- `/persona off` (also `default`, `none`) — returns to pi's built-in prompt.
- A Persona switch applies to subsequent turns only, persists across resume (and BTW forks), and is announced to the model in context by a Switch notice.
- Switching waits for the agent to go idle and rejects otherwise. The first switch per session to a Replace mode Persona asks for confirmation.

## Persona definitions

A Persona definition is a `.md` file: YAML frontmatter plus a body that becomes the persona's prompt.

```markdown
---
name: contrarian
description: Senior-engineer skeptic — challenges assumptions, leads with the strongest objection, concedes when proven wrong.
systemPromptMode: append
---
Your default posture is skepticism. ...
```

Frontmatter is validated strictly: unknown fields, a missing `name`, or broken YAML are parse errors surfaced in the picker instead of being silently ignored.

| Field | Required | Meaning |
| ----- | -------- | ------- |
| `name` | yes | The persona's name — what `/persona <name>` matches, and the collision key across directories. |
| `description` | no | Shown in the picker and in the Switch notice. |
| `systemPromptMode` | no | Prompt mode: `append` or `replace`. Defaults to `append`. |

## Prompt mode

How the body composes with pi's built-in prompt:

- **Append mode** (default): the body is added after pi's built-in prompt, so the agent keeps its built-in tool guidance.
- **Replace mode**: the body replaces the built-in prompt entirely (project context and skills still attach). Because that discards pi's built-in tool guidance, the first Replace mode switch per session requires confirmation.

Unlike agent definitions in the subagents extension — where replace is the default — Personas default to append: the main agent losing its built-in tool guidance is the dangerous case.

## Directories and precedence

| Directory | Path | Precedence |
| --------- | ---- | ---------- |
| Project persona directory | `.pi/personas/` under the project root | highest |
| Global persona directory | `~/.pi/agent/personas/` | middle |
| Bundled personas | shipped inside this package (`extensions/personas/bundled/`) | lowest |

On a name collision the first valid definition wins in that order: a project persona over a global persona, a global persona over the Bundled persona. Missing directories are tolerated.

## Hot reload

Definitions are re-read from disk on every `/persona` invocation — listing and switching — never per turn. The authoring loop is edit → re-run `/persona <name>`, with no session restart. The Active persona's definition is snapshotted at switch time, so per-turn prompt application never touches the disk; re-switch to pick up an edit.

## The bundled persona

This package ships one Bundled persona, `contrarian` (Append mode): a senior-engineer skeptic whose default posture is skepticism, who leads with the strongest objection, argues with concrete failure scenarios instead of vague doubt, concedes explicitly when proven wrong, fabricates no objections, and invents no politeness. Its definition lives at `extensions/personas/bundled/contrarian.md`.

Because the Bundled persona has the lowest precedence, a same-named Persona definition in the Project persona directory or the Global persona directory replaces it without touching this package. The shipped `contrarian` is a starter to keep or replace, not hard-coded behavior.

## Testing

```sh
npx vitest run extensions/personas/
```

Tests drive the extension entry point only: a fake extension API, a scripted UI context, and temp persona directories injected as factory options (the options object is the configuration and test seam).
