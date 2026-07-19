### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

Once a URL is recognized as a GitHub resource, any resolution failure returns a structured error — never a silent fallback to generic HTML extraction. Failures include missing resources, unauthorized access, forbidden resources, rate limits, malformed API responses, oversized resources, and server errors.

Rate-limit failures include HTTP status, remaining quota (when available), reset time (when available), and whether authentication was used. Rate-limited requests are returned immediately without automatic retry.

### Acceptance criteria

- [x] Recognized GitHub URLs that fail resolution return a structured error object, not an HTML-extracted page
- [x] No silent fallback to generic HTML extraction after a recognized GitHub resource fails
- [x] Missing resources (404) return a structured failure with HTTP status
- [x] Unauthorized (401) and forbidden (403) resources return structured failures
- [x] Rate-limited (429 / 403 with rate-limit headers) responses return HTTP status, remaining quota, reset time, and whether authentication was used
- [x] Rate-limited responses are returned immediately — no automatic retry
- [x] Malformed API JSON returns a structured failure
- [x] Unexpected media types return a structured failure
- [x] Server errors (5xx) return structured failures
- [x] Tests cover: unauthenticated 404, authenticated 404, 401, 403, rate-limited with quota metadata, rate-limited without quota metadata, malformed JSON, unexpected media type, 500/502/503

### Blocked by

- 0052 — GitHub URL recognition and ref/path resolution
