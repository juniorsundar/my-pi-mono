### Parent

Spec 0010 — Atomic mutation diff reveal

### What to build

Replace streamed inline mutation diffs with a stable one-line Pending Summary while `edit` and `write` arguments are incomplete, then reveal the existing completed Approval Card at once. This stops large mutation previews from repeatedly expanding the transcript while preserving the current review and approval experience.

### Acceptance criteria

- [ ] Incomplete `edit` and `write` calls render a one-line Pending Summary containing the tool name, any currently available partial target path, and `preparing diff…`
- [ ] The Pending Summary remains one line high as the partial target path grows
- [ ] Rendering incomplete arguments performs no preview work: it does not read the target, validate the mutation, inspect binary state, or generate a diff
- [ ] Incomplete arguments do not display diff lines, binary or unreadable-file warnings, validation errors, or preview-generation errors
- [ ] At the existing `argsComplete` boundary, each Pending Summary switches directly to the existing Approval Card in one Atomic Reveal
- [ ] Completed text mutations preserve the Approval Card's current compact diff, metadata, hunk truncation, line counts, title/path information, and approval hints
- [ ] Completed binary or unreadable targets, invalid edits, and preview-generation failures preserve their existing warning or error card behavior
- [ ] The rendering lifecycle applies consistently to all registered `edit` and `write` calls, including calls that are policy-bypassed or originate in child agents
- [ ] The approval selector remains independent from inline rendering and retains its existing approve, deny, Neovim inspection/editing, and expanded diff-view behavior
- [ ] The change remains within the mutation extension and uses a static pending indicator; it does not require Pi core or rendering API changes
- [ ] Behavioral tests exercise the registered `edit` and `write` renderers with incomplete and complete render contexts, including partial-path growth, exceptional completed outcomes, and the no-preview-work guarantee
- [ ] Existing mutation extension tests pass without weakening current approval-flow or stable-preview coverage

### Blocked by

None — can start immediately.
