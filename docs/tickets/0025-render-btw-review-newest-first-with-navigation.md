# Ticket 0025: Render BTW Review newest-first with navigation

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Add the BTW Review view for completed side-question results. A user can open the review, see completed BTW entries newest-first, read the latest result immediately, expand older results on demand, move through entries with keyboard navigation, and close the view quickly.

### Acceptance criteria

- [x] Opening BTW Review displays completed BTW entries newest-first
- [x] The most recent completed BTW result is expanded by default
- [x] Older completed BTW results are collapsed by default
- [x] Up and down navigation moves the selected BTW result
- [x] Enter or the configured open/toggle key expands and collapses the selected result
- [x] Escape closes BTW Review and returns to the editor
- [x] Empty completed state renders a helpful message instead of a blank view
- [x] BTW Review styling is visually consistent with existing subagent-style result presentation
- [x] Tests cover ordering, default expansion state, navigation, toggle behavior, close behavior, and empty state

### Blocked by

- Ticket 0023 — needs completed BTW entries to review
