# Ticket 0030: Gracefully degrade BTW outside the TUI

### Parent

Spec: `docs/spec/0008-btw-async-side-question.md`

### What to build

Make BTW safe and understandable in non-TUI contexts where editor widgets or custom review views are unavailable. A user in print or JSON-oriented modes should not see crashes from TUI-only APIs; BTW either reports results through an appropriate fallback channel or clearly explains that the interactive review surface is unavailable.

### Acceptance criteria

- [x] Starting a BTW side-question outside the TUI does not crash because the Spinning List is unavailable
- [x] Opening BTW Review outside the TUI does not crash because the custom view is unavailable
- [x] Non-TUI query completion has a clear fallback behavior for success results
- [x] Non-TUI query completion has a clear fallback behavior for error results
- [x] The fallback behavior does not append BTW results to the current session context
- [x] TUI behavior remains unchanged when TUI APIs are available
- [x] Tests cover non-TUI query start, non-TUI query success, non-TUI query failure, non-TUI review invocation, and normal TUI behavior

### Blocked by

- Ticket 0027 — needs the asynchronous query path
- Ticket 0028 — needs the review path
