# Pytest tests for search.py

### Parent

Spec: [docs/spec/0006-switch-web-search-to-searxng.md](../spec/0006-switch-web-search-to-searxng.md)

### What to build

Add pytest-based tests for `search.py`. The script has no tests currently. Write tests that verify the search script's external behavior — URL construction from CLI arguments, parameter mapping (e.g., `safesearch` string to SearXNG integer), response normalization, and error handling — using a mock HTTP server. No real SearXNG instance should be required for test runs.

**Dependencies**: Add `pytest` and `pytest-httpx` as dev dependencies in `pyproject.toml`. Configure pytest in `[tool.pytest.ini_options]`.

**Test coverage**:

- URL construction: verify the correct SearXNG endpoint URL is built from CLI args (query, categories, language, safesearch mapping, timelimit, max results)
- Response normalization: verify SearXNG JSON is transformed into the expected output shape
- Error handling: verify the script produces a controlled JSON error when the SearXNG instance is unreachable, returns non-200, or returns malformed JSON
- CLI exit codes: verify success (0) and error (1) exit codes

### Acceptance criteria

- [x] `pytest` and `pytest-httpx` added to `pyproject.toml` dev dependencies
- [x] `uv run pytest` passes with all tests
- [x] Tests use a mock HTTP server — no real SearXNG instance needed
- [x] URL construction test covers: query, max results, categories, language, safesearch mapping (string to int), timelimit
- [x] Response normalization test covers: successful SearXNG JSON → expected output shape
- [x] Error handling tests cover: unreachable server, non-200 status, malformed JSON
- [x] CLI exit code tests cover: success (0) and error (1)
- [x] Tests do not depend on real web access or a running SearXNG instance

### Blocked by

- [0045-basic-searxng-search-wiring](./0045-basic-searxng-search-wiring.md)
