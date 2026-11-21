# Change Summary at the end of a run

Labels: ready-for-agent

### Parent

None. Designed in a grilling session after Follow Mode (tickets 0074 to 0076); vocabulary in CONTEXT.md (Follow: **Companion Editor**, **Follow Mode**, **Change Summary**). It replaces a considered plan to redirect herdr link clicks at the OS level: herdr hands a Ctrl+click on a terminal link to the system opener of the machine running its window, with no setting or hook to change that.

### What to build

When a run of the main pi session ends, pi lists the files it changed with `edit` or `write`, so the user can see at a glance what to look at in the Companion Editor.

**Recording (in the `follow` extension).** Every successful `edit` or `write` in the main session is recorded: the file, whether it was added (it did not exist before the call) or modified, and the position of the most recent change to it (line and byte column, as Follow Mode already works them out). Recording does not depend on Follow Mode: `/follow off` stops only the automatic jumps. The session's records are not kept across a resume. Like the rest of the extension, nothing is recorded or shown without `NV_SOCKET`, nor in subagents or Persona sessions.

**Showing.** When the run ends (`agent_settled`: it fires once, after any automatic retry or compaction, where `agent_end` can fire before them), if it changed at least one file, pi shows the Change Summary in the transcript: one line per file, paths relative to where pi was started (a file outside it shows its full path), each marked added or modified. There is no hint line after the list (dropped after the first try in herdr). A file changed several times in the run appears once. A run that changed nothing shows nothing. The block is only displayed: it is never sent to the model.

**Known limit.** Files changed by `bash` commands (for example `sed -i`) are not listed, because the extension cannot see them. Note this in a code comment.

**Open risk, settled.** pi's `appendEntry` with `registerEntryRenderer` shows a block in the transcript without it ever reaching the model; its documentation and `session-manager.js` both say plain custom entries do not take part in context.

### Acceptance criteria

- [x] Extension tests check, with a fake `pi` and temporary files:
  - [x] a run with an `edit` and a `write` that creates a file lists both, marked modified and added
  - [x] a file changed twice in one run is listed once
  - [x] a run with no changes, or only failed or blocked calls, shows nothing
  - [x] recording continues with `/follow` off
  - [x] paths relative to the working directory, and a full path for a file outside it
  - [x] nothing recorded or shown without `NV_SOCKET`, and in subagents and Persona sessions
- [x] The block is not part of what the model sees in its next request
- [x] The `bash` limit is noted in the code
- [x] Checked once by hand in herdr: after a run with an `edit` and a `write`, the Change Summary appears once at the end
- [x] `npm test` and `npm run typecheck` pass (apart from the existing `extensions/fold` errors)
