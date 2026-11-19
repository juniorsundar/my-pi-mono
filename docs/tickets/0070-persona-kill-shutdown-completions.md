# Kill, shutdown cleanup, completions and docs for Persona sessions

Labels: ready-for-agent

### Parent

Spec 0013 — Persona Sessions: consult personas as forked herdr sessions

### What to build

`/persona kill <persona>` runs `hc kill` + `hc rm` at once, with no confirm, and drops the persona from the live set. Any in-flight reply is discarded: its watcher delivers nothing. `session_shutdown` kills every live Persona session, and nothing is restored on resume. Argument completions: `/persona <tab>` offers `spawn`, `send-to`, `kill`, `off` and persona names. `send-to <tab>` and `kill <tab>` offer only the names of live Persona sessions. Subcommand names win over same-named personas. Update the README with the Persona session commands, the yolo and shared-tree risk, the trust rule, the subcommand-shadowing note and the `.pi/persona-sessions/` layout.

### Acceptance criteria

- [x] `kill` argv and live-set removal; no `persona-reply` after a kill mid-turn
- [x] Shutdown kills all live sessions; nothing restored on the next `session_start`
- [x] Completions as described, live names only for `send-to` and `kill`
- [x] A persona named like a subcommand is reachable via the picker only, as documented
- [x] `kill` outside herdr refuses
- [x] README updated using the CONTEXT.md vocabulary (Persona session, Session settings)
- [x] vitest and typecheck pass

### Blocked by

0069 — Spawn, send-to and reply delivery for Persona sessions
