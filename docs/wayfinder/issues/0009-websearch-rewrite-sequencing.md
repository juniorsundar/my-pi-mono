# web-search port rewrite sequencing: parallel-then-cut vs big-bang

`wayfinder:grilling` · **RESOLVED** (claimed + resolved by pi-agent this session)

Child of: [Map — `my-pi-mono`: consolidate extensions, migrate web-search to TypeScript](0001-map.md)
Blocked by: [#0008 TS library stack](0008-websearch-ts-library-stack.md) — **resolved**, so this is unblocked.

## Question

How does the phase-2 rewrite proceed now that the TS library stack is chosen ([#0008](0008-websearch-ts-library-stack.md))?

Two shapes are in view:

1. **Parallel-then-cut (module-by-module):** keep `scripts/*.py` running in `my-pi-mono` while the TS port is built alongside it, module by module (search → representation → fetch → github). Each TS module gets its vitest suite ported from the pytest suite and passing *before* the corresponding Python module is removed. Only when the full TS surface passes does the package cut over: delete `scripts/`, `pyproject.toml`, `uv.lock`, `.venv`, and drop the Python shell-out from `index.ts`. Matches the map's standing **no-breakage** preference (the four extensions keep working from `my-pi-mono` throughout).

2. **Big-bang rewrite-then-delete:** write the entire TS port + vitest suite, get it green against the locked fidelity bar (shape + behaviour on the exposed surface; internals free reign), then delete all the Python in one cut and switch `index.ts` to call the TS port.

The decision turns on a few sharp sub-questions:

- **Where does the TS port live during the rewrite?** A `extensions/web-search/src/` tree (so `index.ts` can switch its import from the Python shell-out to the TS barrel at cutover), with `scripts/` left intact and still wired into `index.ts` until the cut? Or does `index.ts` switch early to a TS barrel that itself delegates to Python until each module lands?

- **What's the cut-over unit?** Per module (delete each `.py` as its TS twin passes) or one cut at the end (delete `scripts/` + `pyproject.toml` + `uv.lock` + `.venv` together once the whole TS suite is green)? The map's destination fixes the *end* state (no Python anywhere in the package, one vitest suite) — this is about the path, and about whether an intermediate state has the package half-Python half-TS.

- **Does the readability spike gate the start?** The #0008 resolution flagged a 10-line `@mozilla/readability` + `linkedom` spike as the highest-risk item before committing to the full port. Is that spike a precondition (do it first, fall back to cheerio if it fails), or folded into the first TS module (representation) under parallel-then-cut?

- **Test-suite cutover.** The pytest suite is ~4k lines using `pytest-httpx`; the TS suite uses `msw`. Under parallel-then-cut, each module's pytest tests get ported to vitest alongside its TS twin (so both Python and TS tests run until that module's Python is deleted). Under big-bang, the whole vitest suite is written and the pytest suite deleted at the end. Decide which, and whether the Python tests stay runnable in CI until the cut.

## Context

- **Locked fidelity bar (from map):** shape + behaviour-identical on the exposed `web_search`/`web_fetch` tool surface and `representation`'s `ExtractedDocument` shape; internals free reign (different readability prose is fine — the consumer is an LLM). Tests assert shape + behaviour, not byte-identical prose.
- **Library stack (locked, #0008):** native fetch + `undici`; `@mozilla/readability` + `linkedom` (fallback cheerio); `turndown`; hand-rolled SSRF with `dns.promises.lookup` + `ipaddr.js`; `msw` for HTTP mocking; no GitHub SDK.
- **Standing preference (map Notes):** no breakage during migration — parallel-then-cut-over. Keep things working until the monorepo builds + tests pass, then cut. This ticket is where that preference is confirmed as the *path* for phase 2 specifically, or overridden with reason.
- **Constraints:** NodeNext/ESM, one root `package.json`, root vitest only, no bundler (jiti runtime load). The Python surface today is `extensions/web-search/scripts/` (`search.py`, `representation.py`, `fetch.py`, `github.py`) + `pyproject.toml` + `uv.lock` + `.venv`, shelled out to via `uv` from `index.ts`.
- **Reason D = B:** internals cleanly factored (search/fetch/represent separable) but no speculative public module API exported now.

## Resolution shape

A decision stating: (a) parallel-then-cut or big-bang, (b) where the TS port lives during the rewrite and what `index.ts` calls at each stage, (c) the cut-over unit (per-module deletion vs one final cut), (d) whether the readability spike gates the start, (e) the test-suite cutover plan (do pytest and vitest run in parallel, and when does the pytest suite get deleted). The decision honours the no-breakage preference unless there's a concrete reason to depart; if it departs, it says why. Recorded as a resolution comment; no implementation.
---

## Resolution (this session)

**RESOLVED** via `/grilling` — five sub-questions, all confirmed.

**Decision: parallel-then-cut, with these specifics.**

1. **Top-level shape — parallel-then-cut.** `scripts/*.py` stays the live source of truth (the `uv` shell-out from `index.ts` keeps running) while the TS port is built alongside it, module by module (search → representation → fetch → github). Python is fully functional throughout; no window where `web_search`/`web_fetch` are broken. Honours the map's standing no-breakage preference.

2. **TS home + entry point — `extensions/web-search/src/`, `index.ts` keeps shelling out to Python until the final cut.** The TS twin lives at `extensions/web-search/src/`, built up module by module but not wired into the live tool surface. `index.ts` keeps calling Python via the `uv` shell-out until the final cut; each TS module's vitest suite imports it directly in tests. At the final cut, `index.ts` switches its import to the `src/index.ts` barrel. The one integration gap (barrel wiring to `index.ts`) is closed by an integration test written as part of the final cut's evidence.

3. **Cut-over unit — one final cut.** All Python (`scripts/`, `pyproject.toml`, `uv.lock`, `.venv`, the whole pytest suite) is deleted together at the end, once the entire TS port + vitest suite is green and `index.ts` has switched to the barrel. Test infrastructure stays unified on each side (pytest is the spec until the cut; vitest after). No per-module deletion of `.py` files, no split half-pytest/half-vitest state.

4. **Readability spike gates the start.** Before any module is ported, write and run the 10-line `@mozilla/readability` + `linkedom` spike (`parseHTML` → `new Readability(document).parse()`). If it passes, proceed with the primary stack. If it fails, fall back to `cheerio` *before* `representation.ts` exists — no port code is built on a foundation that might get pulled. Cost is trivial (~10 lines, an hour); retires the highest-risk item (flagged in #0008) up front, consistent with parallel-then-cut's incremental-evidence logic.

5. **Test-suite cutover — port per-module, both run to the cut.** Each module's pytest suite is ported to its vitest twin alongside the TS twin (`search.test.ts` is the direct port of `tests/test_search.py`, etc., using `msw` per #0008). pytest (in `.venv`) and vitest (root) both run until the final cut, at which point the pytest suite is deleted with the rest of the Python. Each module's vitest suite is the direct port of its pytest spec, so the fidelity bar (shape + behaviour on the exposed surface) is checked module-by-module against the spec that defined it. Both runners are already present today, so no new infrastructure.

**Sequence summary:** readability spike (gate) → port search (ts + vitest from pytest) → representation → fetch → github, Python live throughout → final cut: integration test + flip `index.ts` to barrel + delete all Python.

This decides the path only; the port implementation is downstream work (not this ticket).
