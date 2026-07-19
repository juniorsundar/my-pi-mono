# Switch web-search from DuckDuckGo (ddgs) to local SearXNG instance

## Status

Accepted

## Context

The `web-search` extension uses the `ddgs` Python library to search DuckDuckGo. The user runs a local SearXNG instance (NixOS-managed at `127.0.0.1:5340`) that aggregates results from multiple engines (DuckDuckGo, Brave, Google, etc.) and returns richer data than DDG alone: multi-engine provenance, direct answers, spell corrections, query suggestions, and category filtering.

The `web_fetch` tool is unaffected — it fetches and extracts readable content from URLs directly and does not go through any search engine.

## Decision

Replace the DDG-based `search.py` with a thin HTTP client that queries the local SearXNG instance's JSON API. Drop the `ddgs` Python dependency entirely.

The SearXNG base URL is read from `settings.json` under the `searxng.url` key. The tool hard-fails if this key is missing.

### Tool name and extension name

Unchanged. The extension stays `web-search`, tools stay `web_search` and `web_fetch`. The name describes what the tool does, not how it's implemented.

### Parameters changed

| Parameter | Change |
|---|---|
| `query` | Unchanged |
| `maxResults` | Unchanged |
| `categories` | **Added** — `general`, `it`, `news`, `science`, `files`, `social media` |
| `language` | **Added** — `all`, `en`, `de`, `fr`, `es`, `pt`, `zh`, `ja`, `ko`, `ar`, `ru` |
| `safesearch` | Unchanged |
| `timelimit` | Unchanged |
| `region` | **Removed** — replaced by `language` |

### Response format changed

SearXNG returns richer data. The new format surfaces:

- **Answers** — direct answer boxes from SearXNG (shown before results)
- **Corrections** — spell corrections ("Did you mean…?")
- **Suggestions** — related queries for query refinement
- **Per-result `publishedDate`** — recency signal
- **Per-result `engines`** — provenance (which engines found this result)

Dropped from output: per-result `score` (internal ranking, not meaningful to agents), per-result `category` (redundant with query parameter), `infoboxes` (inconsistent across engines).

### Files changed

- `scripts/search.py` — rewritten to call SearXNG HTTP API instead of ddgs
- `pyproject.toml` — drop `ddgs` dependency
- `index.ts` — updated parameter schema, response formatting, description/guidelines, settings.json reader for SearXNG URL

### Files unchanged

- `scripts/fetch.py` — URL fetching is unrelated to search engine choice

## Consequences

### Positive

- Multi-engine aggregation (DDG + Brave + Google + more) gives broader, more reliable results
- Richer response data (answers, corrections, suggestions, provenance, dates)
- Category filtering (`it`, `news`, `science`, etc.) — agents can target searches precisely
- Language filtering replaces ambiguous region codes
- No Python library dependency for search — just HTTP to a local service
- User controls which engines SearXNG queries via its own configuration

### Negative

- Depends on a running SearXNG instance — if the service is down, search fails entirely
- Requires `searxng.url` in `settings.json` — no search without explicit configuration
- Slightly higher latency than direct DDG API (SearXNG queries multiple engines and aggregates)
- Not portable to machines without a SearXNG instance — other users of this extension must set one up

### Risk mitigation

- Hard-fail with a clear error message when `searxng.url` is missing or the instance is unreachable
- SearXNG is NixOS-managed and auto-starts — operational risk is low for the primary user
