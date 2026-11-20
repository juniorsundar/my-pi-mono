# /follow toggles Follow Mode

Labels: ready-for-agent

Blocked by: 0074

### Parent

None. Designed in a grilling session; vocabulary in CONTEXT.md (Follow: **Companion Editor**, **Follow Mode**).

### What to build

`/follow` turns Follow Mode on or off for the current session and says which state it is now in. Follow Mode starts on whenever `NV_SOCKET` is set. Without `NV_SOCKET`, `/follow` explains that there is no Companion Editor to follow, and changes nothing.

### Acceptance criteria

- [ ] With `/follow` off, a successful `edit` sends no jump; turning it back on resumes jumps
- [ ] `/follow` without `NV_SOCKET` notifies and doesn't enable anything
- [ ] Extension tests cover both
- [ ] `npm test` and `npm run typecheck` pass (apart from the existing `extensions/fold` errors)
