# Switch web-search from DuckDuckGo to local SearXNG

### Problem Statement

The `web-search` extension uses the `ddgs` Python library to search DuckDuckGo. This gives the agent a single-engine search experience with no ability to filter by category or language, no multi-engine provenance, and no access to structured extras like direct answers, spell corrections, or query suggestions. The user runs a local SearXNG instance (NixOS-managed) that aggregates results from DuckDuckGo, Brave, Google, and other engines with richer response data — but the extension cannot use it.

### Solution

Rewrite the search backend in `web-search` to call the local SearXNG JSON API instead of the `ddgs` DuckDuckGo library. Add `categories` and `language` as enumerated parameters so the agent can target searches precisely. Surface SearXNG's richer response fields — direct answers, spell corrections, query suggestions, per-result publication dates, and per-result engine provenance — in the tool output. Drop the `region` parameter since `language` provides cleaner intent. Add a `searxng.url` key to `settings.json` so the instance URL is explicitly configured. The `web_fetch` tool remains unchanged — URL fetching is unrelated to search engine choice.

### User Stories

1. As a coding agent, I want to search the web through the user's local SearXNG instance, so that results are aggregated from multiple engines (DuckDuckGo, Brave, Google) rather than a single source.
2. As a coding agent, I want to filter searches by category (`it`, `news`, `science`, `files`, `social media`), so that I can target code-related results, recent news, academic sources, downloadable files, or community discussions without noise from unrelated categories.
3. As a coding agent, I want to filter results by language, so that I can find documentation in a specific language when helping the user with locale-specific dependencies.
4. As a coding agent, I want search results to include direct answers, spell corrections, and query suggestions from SearXNG, so that I can refine my search strategy and extract immediate answers without fetching pages.
5. As a coding agent, I want each result to include its publication date and which engines found it, so that I can assess recency and trustworthiness of results.
6. As a user, I want SearXNG configuration in `settings.json` under a `searxng.url` key, so that the instance URL is explicitly configured and discoverable.
7. As a user, I want a clear error message when `searxng.url` is missing from settings, so that misconfiguration is obvious rather than silently broken.
8. As a user, I want the `web_fetch` tool to continue working unchanged, so that URL content extraction is not affected by the search backend change.
9. As a coding agent, I want category and language choices constrained to valid enums, so that I cannot accidentally pass values that SearXNG does not support and waste a tool call.
10. As a coding agent, I want search to fail gracefully when the SearXNG instance is unreachable, so that I get a clear error instead of a hanging or cryptic failure.
11. As a user, I want the `web_search` and `web_fetch` tool names to remain the same, so that all existing agent prompts, subagent definitions, and deepresearch references continue to work without modification.
12. As a maintainer, I want the `ddgs` Python dependency removed from `pyproject.toml`, so that the extension has one less library dependency and uses the simpler HTTP approach already established by `fetch.py`.

### Implementation Decisions

- **Tool names unchanged.** `web_search` and `web_fetch` stay the same. The extension name `web-search` stays the same. Only the internals of `web_search` change.
- **Rewrite `scripts/search.py` to call SearXNG HTTP API.** The script reads a SearXNG base URL from a CLI argument (passed by the TypeScript layer), constructs a `GET /search?q=...&format=json` request via `httpx`, maps the SearXNG JSON response into the internal result shape, and prints JSON to stdout. The `ddgs` library is removed entirely.
- **`scripts/fetch.py` is untouched.** URL fetching operates independently of the search engine and requires no changes.
- **`pyproject.toml` drops `ddgs`.** The `httpx`, `beautifulsoup4`, `lxml`, `readability-lxml`, and `markdownify` dependencies are retained for `fetch.py`.
- **Parameters added.** `categories` (enum: `general`, `it`, `news`, `science`, `files`, `social media`) and `language` (enum: `all`, `en`, `de`, `fr`, `es`, `pt`, `zh`, `ja`, `ko`, `ar`, `ru`). Both use `StringEnum` in TypeScript to constrain the agent to valid values.
- **Parameter removed.** `region` is dropped. Its purpose (geo/localized results) is better served by the new `language` parameter, and SearXNG's `region` uses a different format that would confuse agents accustomed to DDG-style codes.
- **Response format enriched.** The tool output now surfaces SearXNG's `answers` (direct answer boxes), `corrections` (spell corrections), and `suggestions` (related queries) above the result list. Each result includes `publishedDate` and `engines` (provenance). Per-result `score` and `category` are excluded as noise; `infoboxes` are excluded as too inconsistent.
- **Configuration via `settings.json`.** A new `searxng.url` key in `~/.pi/agent/settings.json` provides the base URL. The extension reads it at tool execution time and passes it to `search.py` as a CLI argument. If the key is missing, the tool hard-fails with a descriptive error message — following the same pattern as the deepresearch extension's `loadDeepresearchConfig()`.
- **`safesearch` and `timelimit` unchanged.** The parameter names and string values remain the same. Any mapping to SearXNG's internal numeric values occurs in `search.py`.
- **`maxResults` unchanged.** SearXNG returns all results in one page; the tool slices client-side.
- **Session startup check updated.** The `session_start` handler verifies SearXNG connectivity instead of ddgs importability.

### Testing Decisions

- **Add pytest tests for `scripts/search.py`.** The script has no tests currently. The rewritten version has testable components: parameter-to-url construction, response normalization, error handling for unavailable instance, and JSON output format.
- **Test external behavior only.** Tests should verify that given CLI arguments, the script produces correct SearXNG URLs, handles well-formed and malformed JSON responses, and exits with appropriate codes. Do not test internals like HTTP session management or JSON parsing implementation — those are handled by `httpx` and `json`.
- **Test with a mock HTTP server.** Use `pytest-httpx` or Python's `http.server` / `responses` library to simulate SearXNG responses. No real SearXNG instance needed for test runs.
- **Add `pytest` and a test runner to `pyproject.toml`.** Configure `[tool.pytest.ini_options]` and add `pytest` as a dev dependency. Tests live in `scripts/tests/` or `tests/`.
- **Prior art:** The deepresearch extension tests its harness config via Vitest at `deepresearch/brain/harness/config.test.ts`. The `subagents` extension has its own Vitest tests. No Python tests exist in the codebase yet — this is new ground, but the approach (test external behavior over HTTP mock) mirrors the TypeScript test patterns.

### Out of Scope

- Changing the `web_fetch` tool in any way
- Supporting SearXNG's `engines` parameter (restricting which engines to query)
- Supporting SearXNG's `pageno` parameter (pagination)
- Surfacing `infoboxes` in the tool output
- Renaming the extension or any tool
- Enabling the SearXNG JSON API on the user's NixOS configuration (already done)

### Further Notes

The SearXNG JSON API was previously returning 403 because `search.formats` only listed `html`. The NixOS config at `/etc/nixos/common/base-common.nix` was updated to add `package = pkgs.searxng;` and `search.formats = [ "html" "json" ];`. This is a prerequisite for the extension change.

The ADR for this decision is at `docs/adr/0004-switch-web-search-to-searxng.md`.
