# /changes opens a changed file in the Companion Editor

Labels: ready-for-agent

Blocked by: 0077

### Parent

None. Designed in a grilling session after Follow Mode (tickets 0074 to 0076); vocabulary in CONTEXT.md (Follow: **Companion Editor**, **Follow Mode**, **Change Summary**). It replaces a considered plan to redirect herdr link clicks at the OS level: herdr hands a Ctrl+click on a terminal link to the system opener of the machine running its window, with no setting or hook to change that.

### What to build

`/changes` opens an arrow-key picker over the files the main session has changed this session (the records from the Change Summary), newest first, with the same added or modified marks. Choosing one sends it to the Companion Editor, which jumps to the first changed line and column of the most recent change to that file. Cancelling the picker does nothing. With nothing changed yet, or without `NV_SOCKET`, `/changes` says so and does nothing else.

**Same safety rules as Follow Mode.** The open does not move the cursor while the Companion Editor is in a typing mode, and never reloads or moves a buffer with unsaved changes. The difference: Follow Mode stays silent when it holds back, but an open the user asked for says why in pi (nvim is in a typing mode, or the buffer has unsaved changes). If nvim cannot be reached, pi says that too. For this, the nvim side has to report why it held back, not only that it did.

Opening works whether or not Follow Mode is on.

### Acceptance criteria

- [ ] Tests against a real headless nvim (they skip themselves where nvim is absent):
  - [ ] the open reloads the file and puts the cursor on the most recent change
  - [ ] held back in a typing mode, with the reason reported
  - [ ] held back for a buffer with unsaved changes, with the reason reported, and the buffer left as it was
- [ ] Tests with a fake `pi`: the picker lists newest first with the marks; choosing sends the file; cancelling sends nothing; empty and no-`NV_SOCKET` cases say so; an unreachable nvim is reported; works with `/follow` off
- [ ] Follow Mode's own jumps behave exactly as before (the 0074 and 0075 tests still pass)
- [ ] Checked once by hand in herdr: `/changes` opens a file in the Companion Editor, and holding back is explained while nvim is in insert mode
- [ ] `npm test` and `npm run typecheck` pass (apart from the existing `extensions/fold` errors)
