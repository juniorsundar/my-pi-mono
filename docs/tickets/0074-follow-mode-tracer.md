# Follow Mode tracer bullet: the Companion Editor jumps to each change

Labels: ready-for-agent

### Parent

None. Designed in a grilling session; vocabulary in CONTEXT.md (Follow: **Companion Editor**, **Follow Mode**).

### What to build

The end-to-end path from a successful `edit` or `write` in the main pi session to the Companion Editor showing that spot.

**Linking (the `nv` script, in the dotfiles repo, outside this repo).** Inside herdr, `nv` picks one socket path per pi pane under the user's runtime directory, keyed by `HC_TERMINAL_ID`. It removes a leftover socket file at that path, starts the Companion Editor with nvim's `--listen` on it, and exports `NV_SOCKET` with that path before it replaces itself with pi. This covers both of its herdr paths (the local window split and the labelled `hc run`). Outside herdr, `nv` is unchanged. The `nv` change is committed in the dotfiles repo.

**Following (a new `follow` extension in this repo).**
- It does nothing at all unless `NV_SOCKET` is set, and only in the main session: subagents and Persona sessions don't follow.
- When an `edit` or `write` call starts, it saves the target file's current contents. A file that doesn't exist yet counts as empty.
- When that call succeeds, it reads the file again. The first character that differs gives the line and column. If nothing differs, or the call failed or was blocked, nvim doesn't move.
- It tells the Companion Editor to reload that file, put the cursor on that line and column, and centre the view. It sends this through `pi.exec` running `nvim --server <socket> --remote-expr` with Lua that nvim evaluates. No new dependency.
- A jump gives up after about 1 second. A failed or timed-out jump is silent: no notice in pi.

### Acceptance criteria

- [ ] Inside herdr, `nv` exports `NV_SOCKET`, and the Companion Editor listens on that socket; a leftover socket file doesn't stop it starting
- [ ] Extension tests, using a fake `pi.exec` and temporary files, check the jump target for:
  - [ ] an `edit` in the middle of a line (correct line and column)
  - [ ] a `write` that overwrites an existing file
  - [ ] a `write` that creates a new file
  - [ ] a change that leaves the file the same (no jump)
  - [ ] a failed or blocked call (no jump)
- [ ] No `NV_SOCKET`: no handlers act and nothing is run
- [ ] A failing or timed-out `nvim --server` call is silent
- [ ] Checked once by hand in herdr: after an `edit` and a `write`, the Companion Editor shows the changed spot
- [ ] `npm test` and `npm run typecheck` pass (apart from the existing `extensions/fold` errors)
