# Spawn, send-to and reply delivery for Persona sessions

Labels: ready-for-agent

### Parent

Spec 0013 — Persona Sessions: consult personas as forked herdr sessions

### What to build

The end-to-end slice inside herdr.

`/persona spawn` opens a repeated-select toggle list of spawnable personas: ✓ per pick, then a final "Spawn selected". Project-directory personas are listed only in trusted projects. For each pick it runs `hc run --bg --json --no-notify --name <id> --cwd <cwd> --parent $HC_TERMINAL_ID -- env PI_PERMISSION_PROFILE=yolo PI_PERSONA_SESSION=<name> pi --fork <main session file> --session-dir <cwd>/.pi/persona-sessions/<id>/ <-a|-na> <session settings argv>`, then records the persona in the in-memory live set. A persona that is already live is skipped with a notice. The session root gets a `*` `.gitignore`.

`/persona send-to <persona> [message]` opens an input dialog when the message is missing. It sends with `hc send -- <terminal> <text>` and no `--if`, so a working persona receives it as a steer. It retries on "unavailable" while the child boots, and returns at once. (A leading `@` needs no escaping: hc delivers the text wrapped as `<hc from="…">…</hc>`, so it never reaches pi's editor as a leading file reference.)

A background watcher (borrowed from herdr.ts `watch`) waits for the turn to end. It then delivers the last assistant text as `persona-reply` (`"<persona>: <text>"`, `display: true`, `triggerTurn: false`). It surfaces the terminal with `herdr-app do terminal.peek` when the child is blocked. On a dead terminal it delivers an exited notice with the last ~15 lines from `hc read` and drops the persona from the live set.

Outside herdr, `spawn` and `send-to` refuse with "needs herdr". The copied hc plumbing carries a `shortcut:` comment.

### Acceptance criteria

- [x] First step: confirm by hand that `hc send` into a working pi arrives as a steer. Record the result in the spec's Further Notes.
- [x] Spawn argv and env exactly as above, with Session settings and the trust flag applied
- [x] Toggle list: picks toggle ✓, "Spawn selected" spawns all of them, cancel spawns nothing
- [x] Untrusted project: project-directory personas are absent from the spawn list
- [x] Already-live persona: skipped with a notice and no `hc run`
- [x] `send-to` argv has no `--if`, the input dialog appears when the message is missing, and the call returns without waiting for the reply
- [x] Reply delivered as `persona-reply` with `triggerTurn: false` after the turn ends, and the terminal stays alive
- [x] Exited child: notice with screen tail, removed from the live set, spawnable again
- [x] Outside herdr: refusal notices; live switching still works
- [x] Tests through the entry point with a scripted `exec`; vitest and typecheck pass

### Blocked by

0067 — Session settings in persona definitions
0068 — Persona session child mode via PI_PERSONA_SESSION
