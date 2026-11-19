# Persona Sessions: consult personas as forked herdr sessions

Labels: ready-for-agent

### Problem Statement

A persona can currently only be applied to the main agent: `/persona contrarian` changes how the agent you're talking to behaves. There is no way to keep working with the main agent and also ask a second voice what it thinks, in the way you'd tag @grok into a thread. Getting the contrarian's opinion means switching the main agent into the contrarian, which changes who you're working with.

### Solution

Keep live switching exactly as it is. Add **Persona sessions**: you spawn one or more personas from the main session, and each one runs as its own long-lived `pi`. A Persona session is forked from the main conversation, runs in a paneless herdr terminal parented to the main session, and has the persona as its Active persona. You message it from the main session without blocking. Its reply comes back into the main session as a displayed message. It stays alive until you kill it or the main session ends. Persona definitions gain optional **Session settings** (model, thinking, tools, extensions, skills, project context, extra args) that shape a Persona session only.

### User Stories

1. As a pi user, I want `/persona` and `/persona <name>` to keep switching the main agent exactly as they do today, so that adding Persona sessions breaks nothing I rely on.
2. As a pi user in herdr, I want `/persona spawn` to let me pick several personas from a toggle list, so that I can bring in more than one voice at once.
3. As a pi user, I want each spawned persona to start from a fork of my current conversation, so that it knows what we are discussing without me re-explaining.
4. As a pi user, I want Persona sessions to live in paneless terminals under my main agent in herdr's agents list, so that they don't take over my layout but I can open one whenever I want.
5. As a pi user, I want `/persona send-to <persona> <message>` to return immediately, so that I can keep working with the main agent while the persona thinks.
6. As a pi user, I want `/persona send-to <persona>` without a message to ask me for the text, so that I don't have to cram a long question into the command line.
7. As a pi user, I want `/persona send-to <tab>` and `/persona kill <tab>` to complete the names of live Persona sessions, so that I never have to remember or type them.
8. As a pi user, I want a message sent while the persona is still answering to steer its current turn, so that I can redirect it without waiting.
9. As a pi user, I want the persona's reply to show up in the main session labelled with the persona's name, so that I can tell who said what.
10. As a pi user, I want a persona's reply not to start a main-agent turn, so that the main agent responds only when I talk to it.
11. As a pi user, I want the main agent to be able to see persona replies on its next turn, so that I can say "address the contrarian's objection" without copying text across.
12. As a pi user, I want a Persona session to stay alive after it replies, so that the next message continues the same conversation with it.
13. As a pi user, I want `/persona kill <persona>` to end a Persona session at once, so that I can drop a voice I no longer need.
14. As a pi user, I want spawning a persona that is already live to be skipped with a notice, so that I don't end up with two contrarians.
15. As a pi user, I want to hear when a Persona session dies on its own (bad model, crash, `/quit`), including the last lines on its screen, so that I can fix it and spawn it again.
16. As a pi user, I want every Persona session killed when the main session shuts down, so that no persona processes are left running.
17. As a persona author, I want to set a persona's model, thinking level, tools, extensions, skills, project context and extra pi args using the same frontmatter fields as agent definitions, so that one format family covers both.
18. As a persona author, I want Session settings to be ignored when the persona is applied to the main agent, so that a persona switch never changes the main agent's model or tools.
19. As a pi user in an untrusted project, I want that project's personas to be unavailable for spawning, so that a cloned repo can't load extensions or flags into a process through a persona definition.
20. As a pi user, I want a Persona session to stay that persona even though the fork carries my main session's persona state, so that a contrarian spawned from a reviewer-persona session is only the contrarian.
21. As a pi user, I want a Persona session to be unable to spawn Persona sessions, so that personas never nest.
22. As a pi user, I want a Persona session to still be able to use subagents, so that it can research before it answers.
23. As a pi user outside herdr, I want `spawn`, `send-to` and `kill` to say they need herdr, while live switching keeps working.

### Implementation Decisions

- **Mechanism** (ADR 0010). Each Persona session is `pi --fork <main session file> --session-dir <cwd>/.pi/persona-sessions/<name>-<hex>/`, started through `hc run --bg --json --no-notify --name <id> --cwd <cwd> --parent $HC_TERMINAL_ID` under the env `PI_PERMISSION_PROFILE=yolo` and `PI_PERSONA_SESSION=<name>`, plus argv built from Session settings. It sets no herdr tab or space labels, so it is paneless. The `.pi/persona-sessions/` directory gets a `*` `.gitignore`.
- **Child-side activation**. When `PI_PERSONA_SESSION` is set, the personas extension makes that persona the Active persona through the existing append/replace composition. It ignores the restored `personas-state` from the fork, skips the Replace mode confirmation, sets no switch notice, and refuses `/persona` (switching, `spawn`, `send-to`, `kill`) with a notice. No `--system-prompt` / `--append-system-prompt` flags are passed.
- **Session settings** in the persona definition parser: `model`, `thinking`, `tools` (string or list), `inheritProjectContext`, `inheritSkills`, `inheritExtensions` / `extensions`, `extraArgs`. They map to pi flags exactly as in `extensions/subagents/src/herdr.ts` `loadAgents`/`extraArgs` (`--model`, `--thinking`, `--tools`, `-nc`, `-ns`, `-ne`, literal args, with `./`/`../` resolved against the definition's directory and `~/` against HOME). They are validated strictly like the other fields. `timeout` and `enabled` are not accepted. The live-switching path never reads them.
- **Trust**. Personas resolved from the Project persona directory are left out of the spawn list unless `ctx.isProjectTrusted()`. Live switching to them is unchanged. The child gets `-a` or `-na` to match the parent's trust, so it never stops on a trust dialog.
- **Commands** (subcommands of `persona`, subcommands win over persona names):
  - `/persona spawn`: a repeated `ctx.ui.select` toggle list. Each pick toggles a ✓ on a spawnable persona, and a final "Spawn selected" entry spawns them. There are no name arguments. A persona that is already live is skipped with a notice.
  - `/persona send-to <persona> [message]`: an `input` dialog if the message is missing. Sends with `hc send -- <terminal> <text>` and no `--if` guard, so a working persona receives it as a steer. The "unavailable while booting" retry is borrowed from herdr.ts. A leading `@` is escaped as in herdr.ts. Never blocks.
  - `/persona kill <persona>`: `hc kill` + `hc rm` at once, no confirm. An in-flight reply is discarded.
  - Completions: `/persona <tab>` offers `spawn`, `send-to`, `kill`, `off`, and persona names. `send-to <tab>` and `kill <tab>` offer only the names of live Persona sessions.
- **Reply delivery**. After each send, a background watcher polls `hc get` and `hc wait` (borrowed from herdr.ts `watch`) until the turn ends. It then reads the last assistant text from the session `.jsonl` and sends `pi.sendMessage({ customType: "persona-reply", content: "<persona>: <text>", display: true }, { triggerTurn: false })`. Several steers during one turn produce one reply. If the child is blocked, its terminal is surfaced with `herdr-app do terminal.peek`. If the terminal is no longer live, the main session gets an "exited" notice with the last ~15 screen lines (`hc read`) and the persona leaves the live set.
- **Lifecycle**. The live set lives in memory (persona name → terminal, session dir). `session_shutdown` kills all of them. Nothing is restored on resume. Transcripts stay on disk.
- **Outside herdr** (`HC_TERMINAL_ID` unset): `spawn`, `send-to` and `kill` notify that they need herdr.
- **hc plumbing** is copied (about 40 lines) from `herdr.ts` with a `shortcut:` comment, not extracted into a shared module.

### Testing Decisions

- **Seam**: the extension entry point only, as in spec 0012. The fake extension API gains a scripted `exec` that records `hc` / `herdr-app` calls and returns canned JSON (`hc run` → address, `hc get` → state/turn/status). Persona session `.jsonl` files are written into the temp session dir to stand in for replies. The UI is scripted for the toggle list and the input dialog. Child mode is tested by setting `PI_PERSONA_SESSION` in the test.
- **Assert on**: spawn argv and env (fork path, session dir, yolo, marker, Session settings flags, trust flag), skip-if-live, untrusted project personas absent from the spawn list, `send-to` argv (no `--if`), the input dialog when the message is missing, the `persona-reply` message shape and `triggerTurn: false`, the exited notice and removal from the live set, kill argv, shutdown cleanup, completions, refusal outside herdr, and child-mode activation (the per-turn hook returns the marker persona's composed prompt even though a different `personas-state` entry was restored, and `/persona` refuses). Session settings parse errors show up in the picker, and live switching ignores those settings.
- **Prior art**: `extensions/personas/index.test.ts` and the subagents herdr tests, if any. Check `extensions/subagents/test/`.

### Out of Scope

- The main agent sending to or spawning personas itself (no tool). Persona sessions are driven by the user only.
- Forwarding main-session turns that happen after spawn. The fork is a snapshot, and you re-spawn for a fresh one.
- Approval prompts in Persona sessions. They run under yolo, and two agents writing to the same tree is an accepted risk.
- Restoring Persona sessions on resume.
- A real multi-select component and name arguments to `spawn`.
- A shared hc helper module across extensions.
- `timeout` and `enabled` in persona definitions.

### Further Notes

- This supersedes spec 0012's out-of-scope line "a persona must never be spawnable". `CONTEXT.md` now defines **Persona session** and **Session settings**, and the Persona vs Agent Type ambiguity was rewritten. A persona is still never run as a *subagent*.
- Verified by hand (ticket 0069): `hc send` into a working pi arrives as a steer. A message sent during a `sleep 25` tool call landed mid-turn as a user message wrapped `<hc from="t59">…</hc>`, one reply covered both messages, and hc's `turn` went 0 → 1 when the turn ended.
- `SessionManager.forkFrom` copies the source `.jsonl` once, so forking the parent's live, append-only file is expected to be safe.
