# Ticket 0034: Document the BTW stream parser seam in project context

### Parent

Architecture review: `extensions/btw/` deepening opportunity #1.

### What to build

Add a concise glossary term to `CONTEXT.md` under the BTW section so future contributors understand that BTW stream semantics are a distinct concern from BTW Process lifecycle.

Proposed term: **BTW Stream Parser** — the module that turns raw NDJSON lines from a BTW Process into structured result data (assistant text, tool trace, usage, model, stop reason). Distinct from BTW Process spawning, which owns args, env, timeout, abort, stderr, and exit-code mapping.

### Acceptance criteria

- [x] `CONTEXT.md` contains a BTW Stream Parser term under the BTW section
- [x] The term describes what the parser owns and how it relates to BTW Process spawning
- [x] The term follows the existing glossary format in `CONTEXT.md`

### Blocked by

- Ticket 0031 — needs the parser module to exist before naming the concept
