# Move herdr subagents onto the herdr library

Labels: ready-for-agent

Blocked by: 0071

### Parent

None. Refactor agreed in a grilling session: merge the duplicated herdr/hc code from `extensions/subagents/src/herdr.ts` and `extensions/personas/persona-sessions.ts` into one library so the hc seam is narrow and `hc` argv is tested in one place. Vocabulary: **Herdr Terminal** (CONTEXT.md, Subagents).

### What to build

The default export of `extensions/subagents/src/herdr.ts` takes an optional `options.herdr`, which defaults to `createHerdr(pi.exec)`. `extensions/subagents/index.ts` keeps calling it with `pi` only.
- Spawning, `/subagent check` reopening, `send`, `watch` and shutdown cleanup use the library.
- `run`, `focus`, `close`, `openPane`, `sessionFile` and `lastText` are deleted.
- `loadAgents` turns frontmatter into the settings shape and calls `piFlags`. The local `extraArgs` is deleted.

Subagent env and flags are unchanged:
- `PI_HERDR_SUBAGENT=1` and `PI_PERMISSION_PROFILE=yolo`
- `--session-dir`, `-a`/`-na`, the system prompt flag and file, `--name`, and the escaping of a leading `@`
- `send` still uses `--if working`

The `watch` loop stays in subagents and keeps every status rule. New tests in `extensions/subagents/test/herdr.test.ts` drive `watch` through the tool with the library fake:
- a finished turn returns `done`, includes the last text, and closes the terminal
- a blocked dialog returns `blocked` and peeks
- a timeout returns `timeout` and leaves the terminal open
- a pi that exits before its turn returns `exited`, includes the screen tail, and closes the terminal

### Acceptance criteria

- [x] `subagents/src/herdr.ts` has no `hc` or `herdr-app` strings
- [x] Agent definition flags come from `piFlags`, and the definition format is unchanged
- [x] The 4 `watch` tests above pass, and `entry.test.ts` still passes
- [x] Spot-checked once by hand in herdr: one blocking subagent and one background subagent complete (both scouts returned correct results; background result arrived as a message)
- [x] `npm test` and `npm run typecheck` pass (typecheck: only the pre-existing `extensions/fold` errors remain)
