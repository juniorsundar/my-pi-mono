# Herdr library: one seam for Herdr Terminals

Labels: ready-for-agent

### Parent

None. Refactor agreed in a grilling session: merge the duplicated herdr/hc code from `extensions/subagents/src/herdr.ts` and `extensions/personas/persona-sessions.ts` into one library so the hc seam is narrow and `hc` argv is tested in one place. Vocabulary: **Herdr Terminal** (CONTEXT.md, Subagents).

### What to build

A library at `extensions/herdr/` with no `index.ts`, so pi never loads it as an extension. It owns every `hc` and `herdr-app` argv in the repo.

`createHerdr(exec)` takes `pi.exec` and returns:

- `startPi({ name, cwd, parent, env, piArgs })` runs `hc run --bg --json --no-notify --name <name> --cwd <cwd> --parent <parent> -- env PATH=<process PATH> <env…> pi <piArgs…>` and returns a handle. It throws with hc's stderr on failure.
- Handle methods:
  - `state()`: `hc get`, normalised to `{ live, turn, status }`, or `undefined` when the call fails
  - `wait(timeoutS, signal?)`: `hc wait <t> --timeout <n>`
  - `send(text, { ifWorking? })`: `hc send [--if working] -- <t> <text>`. It retries up to 15 times while stderr contains `"unavailable"` and the signal has not aborted, and returns `{ ok, error? }`
  - `peek()`: `herdr-app do terminal.peek --terminal <t>`
  - `interrupt()`: `hc interrupt`
  - `screenTail(lines = 15)`: the last lines of `hc read`
  - `close()`: `hc kill` then `hc rm`
  - `remove()`: `hc rm` only, for a terminal that has already ended
- `newRunDir(root, name)` returns `{ id, dir }`. The id is the name slugged to 27 characters plus 4 hex characters, which fits hc's name rules. It creates the folder and writes `*` to `<root>/.gitignore`.
- `lastText(dir)` returns the last assistant text from the newest `.jsonl` in `dir`. It skips a half-written last line and returns `""` when there is none.
- `piFlags(settings, dir)` returns pi flags for `{ model, thinking, tools, inheritProjectContext, inheritSkills, inheritExtensions, extensions, extraArgs }`. It produces `--model`, `--thinking`, `--tools`, `-nc`, `-ns` and `-ne`, and `extraArgs` is split on whitespace. `~/` resolves against HOME, and `./` and `../` resolve against `dir`.

Waiting loops are not part of the library: subagents and Persona sessions keep their own.

The library also exports a test fake, a Herdr Terminal fake that records terminals and calls with no argv parsing, for ticket 0072 and ticket 0073 to share.

Nothing calls the library yet in this ticket.

### Acceptance criteria

- [x] `extensions/herdr/herdr.ts` (plus the fake) exists, has no `index.ts`, and is not loaded as an extension
- [x] `extensions/herdr/herdr.test.ts` checks against a fake `exec`: the `startPi` argv including PATH and env, `send` with and without `--if working`, the "unavailable" retry and its limit, `close` order, `screenTail`, and a failed `hc run` throwing
- [x] `lastText` tests: newest file, a half-written last line, and no text
- [x] `piFlags` tests: every flag, and resolution of `~/`, `./` and `../`
- [x] `newRunDir` tests: id format and length, and the `.gitignore`
- [x] `npm test` and `npm run typecheck` pass (typecheck: only the pre-existing `extensions/fold` errors remain, none in herdr)
