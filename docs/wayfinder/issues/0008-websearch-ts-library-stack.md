# TS library stack for the web-search port

`wayfinder:research` · **RESOLVED** (claimed + resolved by pi-agent this session)

Child of: [Map — `my-pi-mono`: consolidate extensions, migrate web-search to TypeScript](0001-map.md)

## Question

Which TypeScript libraries replace the web-search Python stack — `httpx`, `beautifulsoup4` + `lxml`, `readability-lxml`, `markdownify`, and `pytest-httpx` — under this map's fidelity bar (**shape + behavior-identical on the exposed surface; internals free reign**)? The answer is the set of npm dependencies + the HTTP-mocking strategy the port's vitest suite will use, with enough specificity to start the rewrite.

## Context

- **What's being ported.** `extensions/web-search/scripts/` in `my-pi-mono`:
  - `search.py` (~110 lines) — SearXNG JSON API GET, result normalization. Trivial.
  - `representation.py` (~481 lines) — HTML → readable extraction pipeline: find main container, strip boilerplate, strip anchor links, decode body, normalize whitespace, categorize content. **The hard, fidelity-sensitive part** (replaces `readability-lxml` + `beautifulsoup4`/`lxml`).
  - `fetch.py` (~892 lines) — HTTP fetch with **SSRF guards** (`ipaddress`/`socket` private-IP blocking), binary-download mode, GitHub tree/blob fetching via `github.py`, calls `representation`'s pipeline.
  - `github.py` (~858 lines) — GitHub API tree/blob fetch + tree rendering + `classify`.
  - `pyproject.toml`, `uv.lock`, `.venv/`, `scripts/tests/*.py` (~4k lines of pytest using `pytest-httpx` for HTTP mocking).
- **Fidelity bar (locked):** the `web_search` + `web_fetch` **tool** input/output contracts and `representation`'s exported `ExtractedDocument` shape must hold; the same **behaviours** must be preserved (SSRF private-IP blocking, truncation, content categorization, error paths, binary-download mode). **Internals are free reign** — a different readability library extracting slightly different prose is acceptable; the consumer is an LLM, not a diff. Tests assert shape + behaviour, not byte-identical prose.
- **Constraints from the map.** The package is NodeNext/ESM TypeScript, one root `package.json` (no per-extension manifests), root vitest only, peer-deps `@earendil-works/pi-* ^0.80.0` (installed 0.80.10). No bundler — pi loads via `jiti` at runtime. The port must run under `node` without Python on the host.
- **Reason D (composability, locked = B):** the port is internally factored (search/fetch/represent as separate functions so an in-process import is one `export` away), but **no speculative public internal module API is exported now**. So the library choice should not force a specific public surface — just keep the internals cleanly separable.
- **No-breakage standing preference:** parallel-then-cut-over. The rewrite sequencing (whether TS modules are built alongside the running Python until each passes) is separate fog on the map; this ticket only picks the libraries, not the sequencing.

## What to research (the decision this resolves)

1. **HTTP client.** Replace `httpx` (sync, with timeouts, redirects, byte streaming for downloads, header control). Candidates in scope: native `fetch` (Node 18+ global), `undici` (the fetch impl underneath), `got`. Decide: is native `fetch` + `undici` for low-level control enough, or is a higher-level lib worth the dep?
2. **HTML parsing + readable extraction.** Replace `beautifulsoup4` + `lxml` + `readability-lxml`. This is the core fidelity risk. Candidates: `@mozilla/readability` (the Firefox readability algorithm, DOM-based) + a DOM impl (`linkedom` or `jsdom` — `jsdom` is heavy but mature; `linkedom` is lighter, fits `jiti`/no-bundler); `cheerio` (jQuery-like, no readability built in — would need a readability layer or a custom pipeline); `parse5` alone (low-level, would mean reimplementing the readability heuristics — rejected by the free-reign-internals principle unless paired with a readability lib). Recommend a primary stack + a fallback, and call out which best preserves the current **behaviours** (main-container detection, boilerplate stripping, anchor stripping, content categorization) under fidelity bar C.
3. **HTML → markdown.** Replace `markdownify`. Candidates: `turndown` (the standard), `mdast`/`remark` (heavier). Decide whether markdown conversion stays in `representation` or is folded into the readability step.
4. **SSRF guard.** Replace the `ipaddress`/`socket` private-IP checks. This is behaviour-critical (must keep blocking private/loopback/link-local IPs before fetch). Decide: hand-rolled (parse `URL`, resolve via `dns.promises`, check against IPv4/IPv6 private ranges) vs. an existing lib (`request-filtering-agent`? something else?). Flag any lib's maintenance status.
5. **GitHub API access.** `github.py` uses `httpx` for unauthenticated GitHub tree/blob fetch + renders an ASCII tree. Confirm the TS HTTP client from (1) covers this; no separate GitHub SDK is wanted (the current Python uses no SDK, just REST). Note any rate-limit/auth considerations if relevant.
6. **HTTP mocking for tests.** Replace `pytest-httpx`. Candidates: `msw` (Mock Service Worker, vitest-compatible), `vitest`'s native fetch mocking via `vi.spyOn(global,'fetch')`, `nock`, `undici`'s `MockAgent`. Recommend the one that fits a root-vitest, no-per-extension-config setup and can mock both SearXNG JSON and arbitrary HTML/page fetches + binary downloads + SSRF edge cases.
7. **Dependency weight & maintenance.** For every recommended lib, note: last publish / maintenance signal, ESM + NodeNext compatibility (must `import` cleanly under `jiti`), bundle footprint is irrelevant (no bundler) but install size matters, and whether it pulls in `jsdom`-sized transitive deps.

## Out of scope for this ticket

- Writing any port code. This is research only — produce a decision, not a patch.
- The rewrite sequencing (parallel-then-cut vs big-bang). That's separate map fog.
- Designing or exporting the public internal module API (reason D = B; deferred).
- Migrating the test *content* — this ticket picks the mocking lib; rewriting the assertions is the implementation work that follows.

## Resolution shape

A written decision specifying, for each of the seven points above, the chosen library (or "hand-rolled, here's why") with a one-line rationale, the npm dep(s) to add to root `package.json`, any ESM/NodeNext caveats, and the HTTP-mocking strategy. Include the **fallback** for the readability step specifically (point 2), since that's the highest-risk choice. The resolution is recorded as a comment on this issue; the research artifacts (if any) are linked, not pasted.

## Notes for the research subagent

- Consult the pi docs only if a loading constraint is unclear; the fidelity bar and no-bundler/`jiti` constraint are stated above.
- Prefer primary sources (npm registries, library READMEs, GitHub last-commit dates) over secondary roundups for the maintenance-signal check (point 7).
- The consumer of the output is an LLM tool, so extraction-prose faithfulness is explicitly **not** a constraint — do not recommend `jsdom`-plus-a-clone-of-readability-lxml in pursuit of byte-identical output; recommend the lightest stack that preserves **behaviours**.
---

## Resolution (this session)

**RESOLVED.** Research artifact: [research/0008-ts-library-stack.md](research/0008-ts-library-stack.md).

**Decision (one line per point):**

1. **HTTP client** — native `fetch` + `undici` (low-level opts/streaming/timeouts). Node 18+ fetch covers GET/redirects/headers; no higher-level lib worth the transitive deps.
2. **HTML parse + readability** — `@mozilla/readability` + `linkedom` (PRIMARY), `cheerio` + custom layer (FALLBACK). Firefox reader-view engine is the closest behavioural match to readability-lxml; linkedom is the lightweight DOM (zero jsdom). Slightly different prose is acceptable under the fidelity bar.
3. **HTML→markdown** — `turndown` (ATX headings + `-` bullets match markdownify's config). Stays in `representation`.
4. **SSRF guard** — hand-rolled: `dns.promises.lookup` + `ipaddr.js`. `request-filtering-agent` is an `http.Agent` subclass incompatible with native fetch; the Python check is pre-fetch DNS resolve → IP check, which ports directly. Must replicate all six IP-range categories.
5. **GitHub API** — no extra lib; use #1's fetch for unauthenticated REST. No SDK.
6. **HTTP mocking (tests)** — `msw` (`setupServer` from `msw/node`). Declarative handlers map to pytest-httpx patterns; intercepts at fetch level. SSRF tests mock `dns.promises.lookup` separately.
7. **Weight/maintenance** — all 5 runtime deps lightweight, no jsdom transitives; all actively maintained (last commits 2026). `@mozilla/readability` is CJS-only (jiti interop fine).

**Runtime deps to add (root package.json):** `undici`, `@mozilla/readability`, `linkedom`, `turndown`, `ipaddr.js`.
**DevDeps to add:** `msw`, `@types/turndown`.

**Highest risk:** #2 — `@mozilla/readability`+`linkedom` compatibility is well-evidenced but not officially documented; a 10-line spike test should gate the port before committing. Fallback is cheerio.

This picks the libraries only; the rewrite sequencing and the port implementation are downstream decisions.
