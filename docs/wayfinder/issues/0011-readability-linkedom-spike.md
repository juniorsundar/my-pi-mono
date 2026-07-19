# Readability + linkedom spike: gate the web-search port start

`wayfinder:task` (AFK) · **RESOLVED** by pi-agent

Child of: [Map — `my-pi-mono`: consolidate extensions, migrate web-search to TypeScript](0001-map.md)
Blocked by: [#0008 TS library stack](0008-websearch-ts-library-stack.md) — **resolved**, so this is unblocked. Depends on #0008's choice of `@mozilla/readability` + `linkedom` as the primary HTML-parse + readability stack, with `cheerio` as fallback.

## Question

Run the 10-line spike that gates the start of the web-search port, and report whether `@mozilla/readability` + `linkedom` actually work together at runtime — the highest-risk item flagged in [#0008](0008-websearch-ts-library-stack.md) and named as the gate in [#0009](0009-websearch-rewrite-sequencing.md)'s resolution.

This is the one ticket type that *does* rather than decides. It earns its place by unblocking the conditional confirmation of #0008's HTML-layer choice: the decision to use readability+linkedom was made *conditional* on this spike passing, with cheerio as the fallback. So the spike resolves a decision's condition, not pure execution — if it fails, the HTML-layer decision re-opens (a fresh research/grilling ticket to re-pick around cheerio).

## Task

Write and run the smallest possible end-to-end check of the primary readability stack:

1. In the monorepo (`~/.pi/agent/git/github.com/juniorsundar/my-pi-mono`), add the two runtime deps to root `package.json` (per #0008's recommended deps): `@mozilla/readability` and `linkedom`. `npm install` (or the repo's install command).
2. Write a ~10-line spike (a standalone script or a vitest test, whichever is simpler under the repo's jiti + root-vitest setup) that:
   - Parses a small HTML snippet into a linkedom `Document` (the `parseHTML` from linkedom).
   - Runs `new Readability(document).parse()` and reads the `.title` / `.content` / `.textContent` off the result.
   - Asserts the readable extraction returns non-empty, sensible output for a snippet with boilerplate (nav/header/footer) wrapping an article body.
3. Run it. Capture the pass/fail and, on failure, the error (stack, where it breaks — linkedom DOM missing a method readability calls for, etc.).

## Resolution shape

A comment recording:
- **Pass** → the primary stack (`@mozilla/readability` + `linkedom`) is confirmed viable. The port proceeds with it. The spike artifact (the script/test file) is linked, not pasted. The two deps stay in `package.json`; nothing else changes.
- **Fail** → fall back to `cheerio` (per #0008's fallback). Record the failure mode, confirm cheerio is installed instead, and open a fresh `wayfinder:research` or `wayfinder:grilling` ticket to re-pick the HTML-parse + readability layer around cheerio (since the representation module's shape depends on it). The readability+linkedom deps are removed from `package.json`.

This is the gate; the port's first module (`representation`) does not start until this ticket resolves to Pass (or to Fail-with-cheerio-re-pick). Recorded as a resolution comment; the spike artifact linked, not pasted.

## Resolution

**PASS — `@mozilla/readability` + `linkedom` are viable as the primary HTML layer.** Root runtime dependencies are now `@mozilla/readability@0.6.0` and `linkedom@0.18.13`; no fallback dependency was added. The [runtime spike test](file:///home/juniorsundar/.pi/agent/git/github.com/juniorsundar/my-pi-mono/extensions/web-search/readability-linkedom.spike.test.ts) parses a document with `linkedom`, passes it to `new Readability(document).parse()`, and verifies non-null readable title, HTML content, and text content.

**Evidence:** the focused spike test passed (1/1); root `npm run typecheck` passed; and root `npm test` passed (30 files, 707 tests). `git diff --check` also passed. This validates basic runtime interoperability only — it does not itself port or certify the eventual `representation` behaviour.

**Consequence:** the conditional library choice in [TS library stack for the web-search port](0008-websearch-ts-library-stack.md) is confirmed. The port may begin with `representation` under the already-selected parallel-then-cut sequence; keep `cheerio` as fallback only if later representation work exposes a real limitation.