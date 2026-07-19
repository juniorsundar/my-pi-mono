# Shared test-utils for the web-search port: extract or self-contained

`wayfinder:grilling` · **RESOLVED** (claimed + resolved by pi-agent this session)

Child of: [Map — `my-pi-mono`: consolidate extensions, migrate web-search to TypeScript](0001-map.md)
Blocked by: [#0008 TS library stack](0008-websearch-ts-library-stack.md) — **resolved**, so this is unblocked.

## Question

Does the web-search port's vitest suite introduce **shared test helpers** (HTTP/HTML mocks via `msw`, SSRF IP fixtures, fixture HTML loaders) that get extracted across extensions under a shared `test-utils/` — or do the helpers **stay self-contained** in `extensions/web-search/`?

This was liminal on the map until the HTTP-mocking strategy landed. Now that #0008 locks `msw` (root vitest, `setupServer` from `msw/node`) as the mocking lib and hand-rolled `dns.promises.lookup` + `ipaddr.js` for SSRF, the question is sharp:

- **Extract to a shared `test-utils/`** — e.g. `test-utils/msw.ts` (an `setupServer` factory + common SearXNG/HTML/binary-download handlers), `test-utils/ssrf.ts` (DNS-lookup spies returning private/public IPs), `test-utils/fixtures.ts` (HTML fixture loader). Other extensions (deep-research, mutation) that later need HTTP mocking would import from there. Lives at the repo root or under a `packages/`-style dir; added to root vitest config's `alias`/`include` paths.
- **Self-contained in `extensions/web-search/`** — helpers live in `extensions/web-search/src/__tests__/` or a co-located `_test/` dir; each extension that later needs mocking re-implements or copy-pastes its own. No cross-extension test infrastructure until a *second* consumer actually appears.

The decision turns on:

- **Is there a second consumer now?** Today only web-search has HTTP-fetching tests. `deep-research`/`mutation`/`subagents` don't fetch HTTP in their tests. Extracting shared helpers with one consumer is speculative infrastructure — the same "don't export a public internal API before a real consumer exists" principle (reason D = B) applied to tests.
- **Where do shared helpers live in a one-package layout?** The map locked a flat `extensions/<name>/index.ts` layout with one root `package.json` and root vitest only. A `test-utils/` dir at the repo root is the natural home if extracted — but it adds a path the root vitest config must know about (alias or include glob), and it's a new convention to maintain.
- **What's the threshold to extract?** "When the second consumer appears" (defer, stay self-contained now, extract later if/when deep-research or mutation adds HTTP tests), or "now, because the port's fixtures are obviously reusable" (extract proactively).

## Context

- **Library stack (locked, #0008):** `msw` for HTTP mocking; SSRF tests mock `dns.promises.lookup` separately (not via msw). The fixtures are the two committed HTML files (`scripts/tests/fixtures/github_readme.html`, `readthedocs_page.html`) + whatever the port adds.
- **Map Notes:** one-package layout, root vitest only, no per-extension manifests. Reason D = B — no speculative public/internal surface before a real consumer.
- **Standing preference:** no breakage during migration. Shared test infra is test-only, so it doesn't bear on runtime breakage — but it does bear on test-suite shape, which phase 2 folds into the unified vitest suite.
- **Current state:** `extensions/web-search/scripts/tests/` has pytest (pytest-httpx mocks); the TS port will port those to vitest+msw. No other extension has HTTP-fetching tests today.

## Resolution shape

A decision: extract-now / extract-later-when-second-consumer / self-contained-now-with-a-clear-threshold-to-extract. Specify where helpers live in each case (root `test-utils/`, co-located `_test/`, etc.), how root vitest reaches them (alias/include), and the threshold that triggers extraction if deferred. Honours reason-D=B (no speculative surface before a real consumer) unless there's a concrete reason to build the shared infra now. Recorded as a resolution comment; no implementation.
---

## Resolution (this session)

**RESOLVED** via `/grilling` — two sub-questions, both confirmed.

**Decision: self-contained now; extract on second consumer.**

1. **Core extraction choice — self-contained now, extract on second consumer.** The web-search port's vitest suite keeps its helpers co-located in `extensions/web-search/`; no shared `test-utils/` is built now. Honours reason-D = B directly — the map's "no speculative shared/internal surface before a real consumer" principle applies to test internals just as it does to runtime internals. Today only web-search has HTTP-fetching tests; `deep-research`/`mutation`/`subagents` don't fetch HTTP in their tests, so extracting shared helpers now would be designing a shared API with one consumer. The port's MSW handlers (SearXNG JSON, github README HTML, readthedocs pages), SSRF DNS-lookup spies, and fixture loaders are shaped by web-search's actual pytest suite — naturally web-search-specific, not obviously generic. Deferring means a later extraction generalises from *two* real consumers' helpers, not a guessed shape. Cost of deferring is low (copy-paste into `test-utils/` later is mechanical); cost of extracting now is real (a shared API you might have to re-design when consumer #2 arrives).

2. **Helper home + extraction trigger — `extensions/web-search/__tests__/helpers/`, extract exactly when a second extension adds its first HTTP-fetching test.** Helpers live in `extensions/web-search/__tests__/helpers/` (inside `src`, sibling to the `.test.ts` files), reached by relative import (`./helpers/msw.ts`). No vitest config change — the root `include` glob already covers `extensions/**/__tests__/**`, so the helpers are just TS modules the tests import; no new top-level dir, no new convention. Extraction trigger is sharp and minimal: lift the common bits (MSW `setupServer` factory, SSRF DNS-spy pattern, HTML fixture loader) into a root `test-utils/` (wired into root vitest via `alias`/`include` at that point) **exactly when a second extension adds its first HTTP-fetching test**, not before — that's the "real consumer" test from reason-D = B. `_test/`-outside-src was rejected as adding structural ceremony (a new path + convention with no precedent in the monorepo) for no benefit over vitest's existing `*.test.ts` glob.

This decides the test-helper shape only; the port implementation (and its helper files) are downstream work (not this ticket).
