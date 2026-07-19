# Research: TS library stack for the web-search port

`wayfinder:research` · **Ticket:** [0008-websearch-ts-library-stack](../0008-websearch-ts-library-stack.md) · **Parent map:** [0001](../0001-map.md)

## Decision summary

| # | Concern | Chosen lib(s) | Rationale | Deps to add | Key caveat |
|---|---------|--------------|-----------|-------------|------------|
| 1 | HTTP client | **native `fetch` + `undici`** | Node 18+ global fetch covers GET/redirects/headers; undici gives streaming + max-redirect + timeout control needed for byte streaming and download mode | `undici` | Native fetch IS undici under the hood — explicit dep only needed for `request` low-level opts; jiti/ESM clean |
| 2 | HTML parsing + readability | **`@mozilla/readability` + `linkedom`** (PRIMARY) | Readability is Firefox's reader-view engine (boilerplate stripping, main-container detection, content categorization analog); linkedom is a lightweight DOM that satisfies readability's `document` requirement without jsdom's weight | `@mozilla/readability`, `linkedom` | Readability is CJS-only; jiti handles interop. Linkedom ships both CJS + ESM. Slightly different prose is acceptable under fidelity bar |
| 2 (fallback) | HTML parsing (FALLBACK) | **`cheerio` + custom readability layer** | jQuery-like selector API maps closest to BeautifulSoup patterns; no built-in readability — would need custom boilerplate heuristics or `@paoramen/cheer-reader` port | `cheerio` | More work to replicate readability heuristics; only choose if linkedom+readability proves incompatible |
| 3 | HTML → markdown | **`turndown`** | Standard HTML→MD converter; accepts HTML strings or DOM nodes; ATX headings + bullet options match markdownify's `heading_style="ATX"` + `bullets="-"` | `turndown`, `@types/turndown` (dev) | CJS package with ESM `module` field; jiti handles. Pulls `@mixmark-io/domino` (lightweight DOM, ~50KB) |
| 4 | SSRF guard | **hand-rolled: `dns.promises.lookup` + `ipaddr.js`** | Python SSRF check is pre-fetch DNS resolve → IP range check, not agent-level. `request-filtering-agent` is an `http.Agent` subclass — incompatible with native fetch (README says so, [issue #23](https://github.com/azu/request-filtering-agent/issues/23) open for undici) | `ipaddr.js` | Must replicate `is_loopback`/`is_private`/`is_link_local`/`is_multicast`/`is_unspecified`/`is_reserved` checks; ipaddr.js `.range()` covers IPv4, manual checks for IPv6 |
| 5 | GitHub API | **No extra lib — use #1's fetch** | `github.py` does unauthenticated tree/blob GETs + ASCII tree render. Native fetch handles this directly; no SDK desired per ticket | none | Rate limit: 60 req/hour unauthenticated; add `X-GitHub-Api-Version` header. Auth token can be added later via `Authorization` header |
| 6 | HTTP mocking (tests) | **`msw` (msw/node `setupServer`)** | Declarative `http.get()` handlers with `HttpResponse.json()` / `HttpResponse.text()` map directly to pytest-httpx patterns; intercepts at network level; works with root vitest, no per-extension config; mocks JSON + HTML + binary | `msw` (dev) | Must also mock `dns.promises.lookup` in SSRF tests (like conftest patches `socket.getaddrinfo`). Known vitest+undici MockAgent issue #6952 is avoided — MSW uses its own interceptor, not raw MockAgent |
| 7 | Weight & maintenance | see per-lib details below | — | — | All libs are ESM/CJS dual or CJS-with-jiti-interop; none pull jsdom |

---

## Per-point analysis

### 1. HTTP client — native `fetch` + `undici`

**Primary:** Node 18+ global `fetch` (powered by undici internally) for standard GET requests with redirects, headers, timeouts. Add `undici` explicitly for low-level `request` options needed by the port: `maxRediors`, streaming via `response.body` (Web Streams), and `headersTimeout`/`bodyTimeout`.

**Why not `got`:** `got` is a higher-level lib with retries, hooks, pagination, etc. The port needs simple GET with redirect-following, header control, byte streaming for download mode, and a max-bytes cutoff. Native fetch + undici's `request` covers all of these. Adding `got` would bring ~30 transitive deps for features the port doesn't use. The Python code uses `httpx.Client(follow_redirects=True, max_redirects=5, timeout=...)` + `iter_bytes(chunk_size=65536)` — this maps directly to fetch's `redirect: 'follow'` + reading `response.body` stream chunks.

**Maintenance signal:**
- `undici` v8.7.0, last commit 2026-07-16, maintained by Node.js team, very active (6.6k dependents). [npm](https://www.npmjs.com/package/undici) · [GitHub](https://github.com/nodejs/undici)
- Native `fetch` is stable in Node 18+ (experimental flag removed in Node 21+).

**ESM/jiti note:** `undici` ships CJS (`main: index.js`) with TypeScript types bundled. No `"type": "module"`. Imports cleanly under jiti. `import { request, Agent } from 'undici'` works.

**Deps:** `undici` (runtime, zero transitive runtime deps — it's self-contained)

---

### 2. HTML parsing + readable extraction — `@mozilla/readability` + `linkedom` (PRIMARY)

This is the core fidelity risk. The Python pipeline has two paths:

1. **Semantic container path** (primary): `find_main_container` → `strip_boilerplate` → `strip_anchor_links` → `markdownify`. Maps to: linkedom `parseHTML()` → `document.querySelector('article, main, [role="main"]')` → strip `script/style/noscript/nav/form/button` → strip decorative anchor `<a>` tags → turndown.
2. **Readability fallback**: `readability-lxml` `Document(html, url).summary()` → BeautifulSoup cleanup → markdownify. Maps to: linkedom `parseHTML()` → `new Readability(document).parse()` → turndown on result HTML.

**Why `@mozilla/readability` + `linkedom`:**
- `@mozilla/readability` is Firefox's reader-view engine — the same algorithm family as `readability-lxml` (both descend from Arc90's readability.js). It does main-content detection, boilerplate stripping, title extraction, and returns clean HTML. This is the closest behavioural match to `readability-lxml`.
- `linkedom` provides a lightweight DOM implementation (`parseHTML()` returns a `Document` with `querySelector`, `getElementsByTagName`, `get_text` equivalent, `innerHTML`, etc.). It satisfies readability's `document` parameter requirement. Confirmed working: [defuddle](https://www.npmjs.com/package/defuddle) uses linkedom as optional DOM for readability-style extraction; multiple practitioners report `@mozilla/readability` + `linkedom` as a working combination.
- Linkedom is ~155KB unpacked with zero runtime dependencies. Jsdom is ~8MB+ with many transitive deps. Under the "lightest stack" constraint, linkedom wins decisively.
- The fidelity bar explicitly allows different prose: "a different readability library extracting slightly different prose is acceptable; the consumer is an LLM, not a diff." So `@mozilla/readability` producing slightly different HTML than `readability-lxml` is fine — the behaviours (main-container detection, boilerplate stripping, anchor stripping, content categorization, fallback when content is too short) are preserved.

**Why not `cheerio` (fallback):**
- Cheerio is jQuery-like, maps well to BeautifulSoup patterns, and is very popular (17.7k dependents). But it has no built-in readability heuristics. The port would need to either: (a) implement custom boilerplate-stripping heuristics (reject — reimplementing readability is exactly what the ticket says to avoid), or (b) use `@paoramen/cheer-reader` (a cheerio port of readability.js, but it's a JSR package with minimal npm presence — maintenance risk).
- Cheerio 1.2.0 requires Node ≥20.18.1 and ships ESM-first (`"type": "module"`) with CJS fallback. It works under jiti but is heavier (~1MB unpacked + parse5 + htmlparser2 transitive deps).
- Only choose cheerio if linkedom+readability proves incompatible in practice (unlikely given evidence).

**Maintenance signal:**
- `@mozilla/readability` v0.6.0, Apache-2.0, last commit 2026-07-09 (dependabot updates), maintained by Mozilla engineers (Gijs Kruitbosch). Low release cadence (stable, not dormant — Firefox reader view is production-tested). 14 files, 155KB unpacked. [npm](https://www.npmjs.com/package/@mozilla/readability) · [GitHub](https://github.com/mozilla/readability)
- `linkedom` v0.18.13, MIT, last commit 2026-07-07, actively maintained by Andrea Giammarchi. 961 dependents. [npm](https://www.npmjs.com/package/linkedom) · [GitHub](https://github.com/WebReflection/linkedom)
- `cheerio` v1.2.0 (also 1.1.2 per search — verify), MIT, last commit 2026-07-15, very active. [npm](https://www.npmjs.com/package/cheerio) · [GitHub](https://github.com/cheeriojs/cheerio)

**ESM/jiti note:**
- `@mozilla/readability`: CJS-only (`index.js` uses `require`/`module.exports`, no `"type": "module"`, no `exports` field). jiti handles CJS interop transparently. `import { Readability } from '@mozilla/readability'` works under jiti.
- `linkedom`: dual CJS+ESM (`main: ./cjs/index.js`, has ESM build via rollup). No `"type": "module"`. Ships TypeScript types (`./types/index.d.ts`). `import { parseHTML } from 'linkedom'` works under jiti/ESM.
- Neither pulls jsdom or jsdom-sized transitive deps.

**Deps:** `@mozilla/readability`, `linkedom` (runtime)

**Behavioural fidelity notes:**
- `find_main_container` (article → main → [role=main]): linkedom `document.querySelector('article') || document.querySelector('main') || document.querySelector('[role="main"]')`.
- `strip_boilerplate` (remove script/style/noscript/nav/form/button): linkedom `element.querySelectorAll('script, style, noscript, nav, form, button').forEach(el => el.remove())`.
- `strip_anchor_links` (remove `<a>` with glyph-only text or anchor classes): linkedom `element.querySelectorAll('a').forEach(...)` — check `textContent` and `classList`.
- `extract_title` (head `<title>` → first heading in container): linkedom `document.querySelector('title')` + `container.querySelector('h1, h2, h3, h4, h5, h6')`.
- Readability fallback: `new Readability(document).parse()` returns `{ title, content (HTML), textContent, length, ... }`. If `length < 50`, fall back to body text — matches Python's `len(extracted_text.strip()) < 50` check.
- Content categorization (`html` / `text_like` / `unsupported`): based on Content-Type header string matching — no DOM library needed.

---

### 3. HTML → markdown — `turndown`

**Primary:** `turndown` v7.2.4. Standard HTML→Markdown converter. Accepts HTML strings or DOM nodes. Options match markdownify's usage:
- `headingStyle: 'atx'` → `turndown` `headingStyle: 'atx'` (matches Python's `heading_style="ATX"`)
- `bulletListMarker: '-'` → `turndown` `bulletListMarker: '-'` (matches Python's `bullets="-"`)
- Custom `strip` tags → turndown `remove(['script', 'style', 'noscript', 'nav', 'footer', 'header'])`

**Where it lives:** markdown conversion stays in the `representation` module, after readability/container extraction. The pipeline is: HTML → (linkedom DOM) → strip/clean → `innerHTML` string → turndown → markdown string → normalize whitespace → truncate. This mirrors the Python pipeline exactly.

**Why not `remark`/`mdast`:** remark is a full markdown AST processor — overkill for a one-way HTML→MD conversion. It would add `unified` + `remark-parse` + `remark-stringify` + `hast-util-to-mdast` (4+ packages, heavier). Turndown is a single package that does one thing well.

**Maintenance signal:**
- `turndown` v7.2.4, MIT, last commit 2026-04-03, maintained by mixmark-io (forked from original by Dom Christie). 2.2k+ dependents. Snyk rates maintenance as "Healthy". [npm](https://www.npmjs.com/package/turndown) · [GitHub](https://github.com/mixmark-io/turndown)
- Runtime dep: `@mixmark-io/domino` ^2.2.0 (lightweight DOM, used internally for HTML string parsing in Node.js).

**ESM/jiti note:** `turndown` ships both CJS (`main: lib/turndown.cjs.js`) and ESM (`module: lib/turndown.es.js`). No `"type": "module"`. jiti resolves CJS main. TypeScript types via `@types/turndown` (devDep). `import TurndownService from 'turndown'` works under jiti.

**Deps:** `turndown` (runtime), `@types/turndown` (dev)

---

### 4. SSRF guard — hand-rolled: `dns.promises.lookup` + `ipaddr.js`

**Primary:** Hand-rolled implementation that replicates the Python `is_private_or_local_address` function:

1. Parse URL → extract hostname (native `URL` API).
2. Resolve hostname via `dns.promises.lookup(hostname, { all: true })` → returns `[{ address, family }...]`.
3. For each resolved IP, parse with `ipaddr.js` and check ranges.
4. If any IP is private/loopback/link-local/multicast/unspecified/reserved → block.

**Why not `request-filtering-agent`:**
- It's an `http.Agent`/`https.Agent` subclass. The README explicitly states: **"⚠️ Node.js's built-in `fetch` does not support `http.Agent`"** and [issue #23](https://github.com/azu/request-filtering-agent/issues/23) for undici support is open.
- Had a CVE (GHSA-pw25-c82r-75mm) — SSRF bypass via HTTPS to 127.0.0.1 in v1.x. Fixed in v2.0.0, but the fundamental incompatibility with native fetch remains.
- The Python code's SSRF check is **pre-fetch** (DNS resolve → IP check → then fetch), not agent-level. The TS port should follow the same pattern — this is cleaner and works with any HTTP client.

**Why `ipaddr.js`:**
- `ipaddr.js` v2.1.0 is the library `request-filtering-agent` itself depends on for IP range checking.
- For IPv4: `ipaddr.parse(addr).range()` returns `'private'`, `'loopback'`, `'linkLocal'`, `'multicast'`, `'reserved'`, `'unicast'`, etc.
- For IPv6: `ipaddr.parse(addr)` returns an `IPv6` object with `.isLoopback()`, `.isLinkLocal()`, etc. Some ranges need manual checks (e.g., `::` unspecified, `ff00::` multicast).
- Small, focused, zero runtime deps, MIT.

**Maintenance signal:**
- `ipaddr.js`: v2.1.0, MIT, maintained by whitequark. Used by `request-filtering-agent`, `node-fetch`, etc. [npm](https://www.npmjs.com/package/ipaddr.js)
- `request-filtering-agent` v3.2.1 (for reference — NOT recommended), last commit 2026-06-29, ESM-only (`"type": "module"`), Node ≥20. [npm](https://www.npmjs.com/package/request-filtering-agent) · [GitHub](https://github.com/azu/request-filtering-agent)

**ESM/jiti note:** `ipaddr.js` is CJS. jiti handles it. `import ipaddr from 'ipaddr.js'` works.

**Deps:** `ipaddr.js` (runtime)

**Behavioural fidelity:** The Python code checks `is_loopback`, `is_private`, `is_link_local`, `is_multicast`, `is_unspecified`, `is_reserved` for each resolved IP. The TS port must replicate all six checks. The `PRIVATE_HOST_CACHE` (hostname → bool map) should also be replicated (or use a `Map`).

---

### 5. GitHub API — no extra lib

**Primary:** Use the HTTP client from #1 (native fetch / undici `request`). `github.py` does:
- Unauthenticated GET to `api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1` (tree fetch).
- Unauthenticated GET to `api.github.com/repos/{owner}/{repo}/git/blobs/{sha}` (blob fetch, base64 content).
- URL classification (`classify`) — pure string/regex parsing, no HTTP.
- Tree rendering — pure string formatting.

All of this is simple HTTP GET + JSON parsing. No SDK needed (ticket says "no separate GitHub SDK wanted").

**Rate-limit/auth notes:**
- Unauthenticated GitHub API: 60 requests/hour per IP. The port should pass `X-GitHub-Api-Version: 2022-11-28` and `Accept: application/vnd.github+json` headers.
- If auth is needed later: add `Authorization: Bearer <token>` header — no code restructuring required.
- The `classify` function (URL → `GitHubResource`/`NonSpecialized`) is pure parsing — port directly to TS, no library.

**Deps:** none (uses #1's fetch)

---

### 6. HTTP mocking (tests) — `msw`

**Primary:** [MSW](https://mswjs.io) v2.15.0, using `setupServer` from `msw/node`. Declarative request handlers with `http.get()`, `http.post()` and `HttpResponse.json()` / `HttpResponse.text()` / `HttpResponse.arrayBuffer()`.

**Why MSW:**
- Intercepts at the network level (patches `global.fetch` via `@mswjs/interceptors`) — the code under test doesn't know it's mocked. This matches `pytest-httpx`'s behaviour.
- Declarative handlers map directly to pytest-httpx's `httpx_mock.add_response(url=..., json=...)` pattern.
- Can mock: SearXNG JSON API responses, HTML page fetches, binary downloads (via `HttpResponse.arrayBuffer()`), GitHub API JSON, error responses (status codes), redirect chains.
- Works with root vitest — no per-extension config. `setupServer(...handlers)` in a `beforeAll`/`afterEach` block in the test file or a shared setup.
- ESM + CJS dual exports (`msw/node` has explicit Node entry point).

**SSRF test mocking:** Like the Python `conftest.py` patches `socket.getaddrinfo`, the TS tests must mock `dns.promises.lookup` (or the port's SSRF function) to return a public IP. Use `vi.spyOn(dns.promises, 'lookup')` or mock the internal SSRF module function. This is separate from MSW (which handles HTTP, not DNS).

**Why not `vi.spyOn(global, 'fetch')`:**
- Works for simple cases but requires manually constructing `Response` objects for every test. For ~4k lines of tests being ported from pytest-httpx, MSW's declarative handler pattern is more maintainable.
- MSW can be a secondary tool for simple cases — both can coexist.

**Why not `undici MockAgent`:**
- Known incompatibility with vitest: [issue #6952](https://github.com/vitest-dev/vitest/issues/6952) — vitest's happy-dom integration overrides fetch, breaking MockAgent interception. Closed as "upstream" / "not planned". MSW uses its own interceptor (`@mswjs/interceptors`) which patches at a different level and is not affected.

**Why not `nock`:**
- `nock` patches `http.ClientRequest` — works with `http`/`https` module but not native `fetch`/undici without additional setup. Older API style. MSW is the modern standard for fetch-based code.

**Maintenance signal:**
- `msw` v2.15.0, MIT, last commit 2026-07-08, actively maintained by Artem Zakharchenko (kettanaito). 492 dependents. [npm](https://www.npmjs.com/package/msw) · [GitHub](https://github.com/mswjs/msw)

**ESM/jiti note:** `msw` is `"type": "commonjs"` with dual ESM+CJS exports. `msw/node` has explicit Node entry. Works in vitest's Node environment. DevDependency only.

**Deps:** `msw` (dev)

---

### 7. Dependency weight & maintenance summary

| Lib | Version | Last commit | License | Module type | Runtime deps | Unpacked size | jiti/ESM OK? | Dev or runtime? |
|-----|---------|------------|---------|-------------|-------------|---------------|-------------|-----------------|
| `undici` | 8.7.0 | 2026-07-16 | MIT | CJS (main) + types | 0 (self-contained) | ~2MB | ✅ | runtime |
| `@mozilla/readability` | 0.6.0 | 2026-07-09 | Apache-2.0 | CJS (require/module.exports) | 0 | ~155KB | ✅ (jiti CJS interop) | runtime |
| `linkedom` | 0.18.13 | 2026-07-07 | MIT | CJS (main) + ESM (module) | 0 | ~600KB est. | ✅ | runtime |
| `turndown` | 7.2.4 | 2026-04-03 | MIT | CJS (main) + ESM (module) | 1 (`@mixmark-io/domino`) | ~100KB + domino ~50KB | ✅ | runtime |
| `ipaddr.js` | 2.1.0 | active | MIT | CJS | 0 | ~50KB | ✅ | runtime |
| `msw` | 2.15.0 | 2026-07-08 | MIT | CJS + ESM dual | `@mswjs/interceptors` + others | ~700KB | ✅ | dev |
| `@types/turndown` | latest | — | — | — | — | — | ✅ | dev |

**No jsdom in the tree.** None of the recommended runtime deps pull jsdom. `@mozilla/readability` lists jsdom as a devDependency only (for its own test suite) — not a runtime transitive.

**Total runtime deps to add:** `undici`, `@mozilla/readability`, `linkedom`, `turndown`, `ipaddr.js` (5 packages, all lightweight, zero pull jsdom-sized transitives).

**Total devDeps to add:** `msw`, `@types/turndown` (2 packages).

---

## Recommended root package.json deps to add

```jsonc
{
  "dependencies": {
    "@mozilla/readability": "^0.6.0",
    "ipaddr.js": "^2.1.0",
    "linkedom": "^0.18.13",
    "turndown": "^7.2.4",
    "undici": "^7.0.0",
    "yaml": "^2.9.0"  // existing
  },
  "devDependencies": {
    "@types/turndown": "^5.0.5",
    "msw": "^2.15.0",
    // existing devDeps unchanged
  }
}
```

**Note on `undici` version range:** The installed Node version determines the built-in undici. The explicit `undici` dep should match or exceed the Node bundled version. `^7.0.0` is safe for Node 20–22; if running Node 24+, use `^8.0.0`. Pin to whatever the monorepo's Node engine target supports. The `@earendil-works/pi-*` peer-deps at 0.80.10 likely target Node 20–22, so `^7.0.0` is the conservative choice. Verify against the actual Node version in use.

---

## Risks / open follow-ups

1. **`@mozilla/readability` + `linkedom` runtime compatibility** — Well-evidenced (defuddle uses linkedom, multiple practitioners report success) but not officially documented in readability's README (which mentions only jsdom by name). **Mitigation:** A 10-line spike test (`parseHTML` → `new Readability(document).parse()`) should be run before committing to the full port. If it fails, fall back to cheerio (#2 fallback).

2. **`@mozilla/readability` is CJS-only** — No `"type": "module"`, no `exports` field. jiti handles CJS interop, but if the monorepo ever moves to pure ESM (no jiti), a wrapper or `createRequire` shim would be needed. Low risk — jiti is the runtime loader per the map's constraints.

3. **SSRF guard completeness** — The hand-rolled IP range checks must cover all six categories the Python code checks (loopback, private, link-local, multicast, unspecified, reserved). `ipaddr.js` IPv4 `.range()` covers most; IPv6 needs manual checks for multicast (`ff00::/8`), unspecified (`::`), and reserved ranges. **Mitigation:** Port the existing test suite's SSRF edge cases (they test each category) — if tests pass, coverage is complete.

4. **MSW + vitest environment** — MSW works in vitest's default Node environment. If any test file uses `environment: 'happy-dom'` or `environment: 'jsdom'`, MSW interception may break (see vitest issue #6952 root cause). **Mitigation:** Keep web-search tests in the default Node environment (no DOM env needed — the port uses linkedom, not browser globals).

5. **Turndown prose differences from markdownify** — Turndown may produce slightly different markdown (e.g., table formatting, code block fences, link reference style). Under the fidelity bar this is acceptable (LLM consumer, not diff). **Mitigation:** Test assertions check shape + behavior, not byte-identical markdown.

6. **Undici version vs Node bundled** — If the explicit `undici` dep version diverges significantly from the Node-bundled undici, `globalThis.fetch` and `import { request } from 'undici'` may use different undici versions. **Mitigation:** Pin `undici` to match the Node target, or use only `globalThis.fetch` for standard requests and reserve explicit `undici` imports for streaming/low-level only.

7. **`@mozilla/readability` low release cadence** — v0.6.0 is the latest, published ~1 year ago. The library is stable (Firefox reader view is battle-tested) but receives infrequent npm releases. Last commit is recent (dependabot updates). Not dormant — just stable. **Mitigation:** Low risk; if a fix is needed, the library is small enough to fork/patch.