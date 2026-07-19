# Basic SearXNG search wiring

### Parent

Spec: [docs/spec/0006-switch-web-search-to-searxng.md](../spec/0006-switch-web-search-to-searxng.md)

### What to build

Replace the DuckDuckGo search backend with a local SearXNG instance. Rewrite `search.py` to call the SearXNG JSON API via `httpx` instead of using the `ddgs` library. The tool must read the SearXNG URL from `settings.json` under `searxng.url` and hard-fail with a clear error if missing. This slice keeps the existing parameter set (`query`, `maxResults`, `safesearch`, `timelimit`) and the existing flat response format — no new parameters and no enriched output yet. Drop the `ddgs` dependency from `pyproject.toml`. Update the session startup check to verify SearXNG connectivity instead of ddgs importability.

The `web_fetch` tool is untouched.

### Acceptance criteria

- [ ] `web_search` returns results from SearXNG (multi-engine aggregation) when `searxng.url` is configured
- [ ] Missing `searxng.url` in `settings.json` produces a clear, descriptive error
- [ ] Unreachable SearXNG instance produces a clear error (not a hang or cryptic failure)
- [ ] Existing parameters `query`, `maxResults`, `safesearch`, `timelimit` work as before
- [ ] `web_fetch` continues to work unchanged
- [ ] `ddgs` is no longer in `pyproject.toml` dependencies
- [ ] Session startup check reports SearXNG connectivity status (not ddgs)
- [ ] TypeScript compiles without errors; extension registers successfully in pi

### Blocked by

None — can start immediately.
