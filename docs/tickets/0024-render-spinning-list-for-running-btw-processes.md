# Ticket 0024: Render the Spinning List for running BTW Processes

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Show a Spinning List above the editor while BTW Processes are running. The list gives users lightweight awareness of pending side-questions, supports multiple concurrent items, includes a progress count, and disappears naturally when no BTW Processes remain.

### Acceptance criteria

- [x] No Spinning List is shown when there are no running BTW Processes
- [x] One running BTW Process shows a BTW header and one spinner item
- [x] Multiple running BTW Processes show one spinner item per question
- [x] The header shows the current BTW progress count
- [x] Each spinner item includes enough question text to identify the side-question
- [x] Completing or failing a BTW Process updates the Spinning List
- [x] The Spinning List clears when the final running BTW Process completes or fails
- [x] Tests cover empty, single-running, multiple-running, update, and clear rendering behavior

### Blocked by

- Ticket 0023 — needs running BTW entries to render
