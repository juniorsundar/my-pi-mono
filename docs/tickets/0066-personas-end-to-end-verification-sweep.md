# Personas end-to-end verification sweep against spec 0012

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

The final gate. Sweep the whole feature against spec 0012's user stories in one pass: the full vitest suite and typecheck green across the monorepo, a manual smoke of every end-user behavior (switch, picker, default aliases, unknown-name error, idle guard, resume, fork, compaction, replace-confirm, invalid definitions, precedence, hot reload, contrarian out of the box), and consistency of the documentation chain — spec 0012 ↔ ADR 0009 ↔ the root context document's Personas glossary ↔ package README. Fix anything that fails the sweep; do not defer to new tickets unless a genuine scope gap appears.

### Acceptance criteria

- [ ] `npx vitest run` and `npm run typecheck` pass for the whole monorepo
- [ ] Every user story in spec 0012 is manually smoked or covered by a seam test; discrepancies fixed or, if genuinely out of scope, recorded back onto the spec
- [ ] A live pi session demonstrates: `/persona` picker → switch → status line → resume honoring the persona → return to default
- [ ] No test observes internal module state; everything remains at the single extension entry point seam
- [ ] Documentation chain is consistent: glossary terms used everywhere, no "mode"/"profile"/"agent" drift; ADR 0009's consequences still hold in code
- [ ] The personas extension auto-loads from the repo's single `pi.extensions` package configuration with no extra registration

### Blocked by

0061 — Personas session persistence and switch notices
0062 — Personas three-directory resolution, precedence, hot reload
0063 — Personas replace mode with one-time confirmation
0064 — Personas invalid definitions surfaced, never thrown
0065 — Ship the contrarian bundled persona and authoring docs