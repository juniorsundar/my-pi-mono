# Follow Mode never disturbs the user

Labels: ready-for-agent

Blocked by: 0074

### Parent

None. Designed in a grilling session; vocabulary in CONTEXT.md (Follow: **Companion Editor**, **Follow Mode**).

### What to build

The nvim side of a jump respects what the user is doing in the Companion Editor:
- If nvim is in insert or command-line mode, the jump is skipped, so the cursor is never pulled away mid-typing.
- If the changed file's buffer has unsaved changes, nvim neither reloads nor moves, and shows a short warning in nvim. The user's unsaved work is never overwritten.
- If a window already shows the file, the jump uses that window. Otherwise it uses the current window.
- Keyboard focus stays in the pi pane. Jumps go over the socket, so nothing focuses the Companion Editor's pane.

### Acceptance criteria

- [ ] Tests check that the Lua sent to nvim contains the mode check, the unsaved-buffer check (with its warning) and the reuse of a window already showing the file
- [ ] Checked once by hand:
  - [ ] typing in insert mode isn't interrupted
  - [ ] an unsaved buffer shows the warning and keeps its contents
  - [ ] an existing split showing the file is reused
- [ ] `npm test` and `npm run typecheck` pass (apart from the existing `extensions/fold` errors)
