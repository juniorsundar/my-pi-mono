# Personas end-to-end verification sweep against spec 0012

Labels: ready-for-agent

### Parent

Spec 0012 — Personas: live-switchable prompt profiles for the main agent

### What to build

The final gate. Sweep the whole feature against spec 0012's user stories in one pass: the full vitest suite and typecheck green across the monorepo, a manual smoke of every end-user behavior (switch, picker, default aliases, unknown-name error, idle guard, resume, fork, compaction, replace-confirm, invalid definitions, precedence, hot reload, contrarian out of the box), and consistency of the documentation chain — spec 0012 ↔ ADR 0009 ↔ the root context document's Personas glossary ↔ package README. Fix anything that fails the sweep; do not defer to new tickets unless a genuine scope gap appears.

### Acceptance criteria

- [x] `npx vitest run` and `npm run typecheck` pass for the whole monorepo
- [x] Every user story in spec 0012 is manually smoked or covered by a seam test; discrepancies fixed or, if genuinely out of scope, recorded back onto the spec
- [x] A live pi session demonstrates: `/persona` picker → switch → status line → resume honoring the persona → return to default
- [x] No test observes internal module state; everything remains at the single extension entry point seam
- [x] Documentation chain is consistent: glossary terms used everywhere, no "mode"/"profile"/"agent" drift; ADR 0009's consequences still hold in code
- [x] The personas extension auto-loads from the repo's single `pi.extensions` package configuration with no extra registration

### Blocked by

0061 — Personas session persistence and switch notices
0062 — Personas three-directory resolution, precedence, hot reload
0063 — Personas replace mode with one-time confirmation
0064 — Personas invalid definitions surfaced, never thrown
0065 — Ship the contrarian bundled persona and authoring docs

### Sweep result

Suite: 988 tests / 36 files pass; `tsc --noEmit` clean.

Live smoke drove real `pi --mode rpc` sessions against a temp project (`.pi/personas/` with valid, replace-mode, and deliberately broken definitions) and confirmed, end to end: auto-load from the single `pi.extensions` entry (`/persona` resolves to `extensions/personas`), picker contents and ordering with the disabled parse-error entry and Default last, direct switch, status line, context-visible switch notice, project-over-bundled precedence, hot reload on the next switch, unknown-name error listing available personas, parse error surfaced as a warning, replace-mode one-time confirmation, `off`/`none` aliases returning to the built-in prompt, persona-state and switch-notice entries in the session file, resume restore without re-emitting the notice, and fork restore.

Idle guard, as observed live: pi accepts the command mid-run, the extension waits, and the switch lands only after the run settles — including when the run is aborted, because `AgentSession.waitForIdle()` resolves and never rejects (its idle promise captures only `resolve`). So of the extension's two rejection paths, only the post-wait `isIdle()` recheck is reachable against pi 0.86.1; the surrounding `catch` guards the contract rather than an observed path. Behavior matches the spec (a switch never races an in-flight turn); no change needed.

Compaction was verified by construction rather than by a live compaction run: restore reads `sessionManager.getEntries()`, which pi documents and implements as the raw append-only entry list (compaction-aware views are the separate `buildContextEntries`/`buildSessionContext`), so a compaction entry cannot prune the persona-state entry; the per-turn override (ADR 0009) rebuilds the prompt rather than baking it into history. The seam test models exactly this. Driving a real compaction needs >20k context tokens (`compaction.keepRecentTokens` defaults to 20000) and minutes of summarization model time to exercise pi's compactor, not personas.

One gap found and fixed: ADR 0009's consequences did not record that replace mode hand-mirrors pi's custom-prompt assembly (append prompt, project context, skills, cwd) and therefore drifts if pi changes that assembly, nor the compaction-immunity of the restore path. Both are now consequences in ADR 0009. No code changes were required.