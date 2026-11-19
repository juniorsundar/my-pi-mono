# Persona sessions run as forked pi sessions in paneless herdr terminals

Besides live switching (ADR 0009), a persona can run as a **Persona session**: a long-lived `pi` forked from the main session, consulted by the user through `/persona spawn`, `/persona send-to <persona> <message>` and `/persona kill <persona>`. Each Persona session is an hc terminal parented to the main session's terminal, with no herdr tab or pane labels. It appears under the main agent in herdr's agents list and floats over the tab when clicked or blocked, the same way herdr subagents do (`extensions/subagents/src/herdr.ts`). It starts as `pi --fork <main session file> --session-dir <cwd>/.pi/persona-sessions/<id>/` under `PI_PERMISSION_PROFILE=yolo`. Sending is non-blocking. A send while the persona is working becomes a steer. When a turn ends, the last assistant text comes back into the main session as a displayed `persona-reply` message that does not trigger a main-agent turn. The terminal stays alive until it is killed or the main session shuts down. Nothing is restored on resume.

The child learns which persona it is from an env marker (`PI_PERSONA_SESSION=<name>`), not from `--system-prompt` or `--append-system-prompt`. The forked session file contains the main session's `personas-state` entries, so the child's personas extension would otherwise restore the main session's Active persona and stack it on top of the spawned one. With the marker, the child's personas extension makes the named persona its Active persona through the existing append/replace composition, ignores the restored state, and disables `/persona` switching and `spawn`. That last part is also what prevents nested Persona sessions. Subagents stay available inside a Persona session.

Persona definitions gain **Session settings**: the agent-definition fields `model`, `thinking`, `tools`, `inheritProjectContext`, `inheritSkills`, `inheritExtensions`/`extensions` and `extraArgs`, with the same names and meanings. They shape a Persona session only. Live switching still ignores them, so ADR 0009's rule that a switch never changes the main agent's model or tools still holds. When the fields are absent, the session gets what a plain `pi` would. Because these fields reach argv, project-directory personas can be spawned only in trusted projects. Live switching to them still works everywhere.

## Considered options

- **Env-marker activation** (chosen): reuses the tested prompt composition and fixes the inherited-state double persona in the same change.
- **`--system-prompt` / `--append-system-prompt` files** (what herdr subagents do): rejected. The forked `personas-state` entry still gets restored and stacked on top.
- **Clean, non-forked session per message** (the subagent model): rejected. The persona would not see the conversation it is being asked about.
- **Approvals instead of yolo**: rejected by choice. Persona sessions run unattended between messages. The cost is that two agents can write to the same tree with only the mutation extension's hard blocks in between.
- **Shared hc helper module with the subagents extension**: deferred. The roughly 40 lines of hc plumbing are copied into the personas extension with a `shortcut:` comment, until a third caller exists.

## Consequences

- The fork is a snapshot taken at spawn. Main-session turns after spawn are invisible to the persona unless the user re-spawns it.
- Two steers during one turn produce one reply.
- Persona session transcripts persist under `.pi/persona-sessions/` (gitignored) after the session is killed.
- Outside herdr (`HC_TERMINAL_ID` unset), `spawn`, `send-to` and `kill` refuse. Live switching is unaffected.
