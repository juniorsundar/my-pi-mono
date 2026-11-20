# Move Persona sessions onto the herdr library

Labels: ready-for-agent

Blocked by: 0071

### Parent

None. Refactor agreed in a grilling session: merge the duplicated herdr/hc code from `extensions/subagents/src/herdr.ts` and `extensions/personas/persona-sessions.ts` into one library so the hc seam is narrow and `hc` argv is tested in one place. Vocabulary: **Herdr Terminal** (CONTEXT.md, Subagents).

### What to build

`createPersonaSessions` takes an optional `options.herdr`, which defaults to `createHerdr(pi.exec)`. It uses `startPi`, the handle, `newRunDir`, `lastText` and `piFlags` from the library. The `hc` code copied from `herdr.ts` is deleted, along with its `shortcut:` comment, `hcJson` and the local `lastText`. `persona-session-args.ts` is deleted, and the persona's Session settings go to `piFlags` instead.

The watcher stays in personas and keeps its current behaviour:
- it delivers a reply every turn
- it treats the terminal as dead only after hc reports the end or after 3 failed checks in a row
- it peeks once per blocked state
- once a session is killed, nothing more is delivered

`personas/index.test.ts` is rewritten against the library fake in place of the argv-parsing fake `hc`:
- Spawn tests check `startPi` calls (env `PI_PERMISSION_PROFILE=yolo` and `PI_PERSONA_SESSION`, plus `--fork`, `--session-dir`, `-a`/`-na` and Session settings flags), not `hc run` argv.
- Send-to tests check `send(text)` with no `ifWorking`. The retry test moves to the library.
- The "argv mapping as in herdr agent definitions" block is replaced by one test showing that Session settings reach `piFlags`.

### Acceptance criteria

- [x] `persona-sessions.ts` has no `hc` or `herdr-app` strings, and `persona-session-args.ts` is gone
- [x] Persona session behaviour is unchanged: spawn, already-live skip, send-to with no `--if`, reply delivery, tolerating failed checks, peek on blocked, exit notice with screen tail, kill, and killing everything at shutdown
- [x] Persona tests use the library fake and do not parse `hc` argv
- [x] Persona tests are shorter overall (net -186 lines across personas), and the removed coverage is covered by `herdr.test.ts`
- [x] `npm test` and `npm run typecheck` pass (typecheck: only the pre-existing `extensions/fold` errors remain)
