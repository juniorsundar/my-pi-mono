### Parent

Spec 0009 — Recoverable Web Fetches and GitHub Resources

### What to build

Blob URLs recognized by the GitHub URL module return file content via the GitHub API. Readable and raw modes work for text blobs; detected binary blobs are rejected with guidance to use download mode. Download mode obtains blob bytes through the API, applies existing byte-ceiling and media-type policies, and returns binary download metadata.

Authentication uses `GITHUB_TOKEN` when available, confined to fixed GitHub API hosts.

### Acceptance criteria

[x] Text blob URLs return file content in readable mode (Markdown or text extraction applied)
[x] Text blob URLs return decoded file source in raw mode (no extraction)
[x] Detected binary blobs are rejected in readable and raw modes with a clear message guiding the agent to use `download: true`
[x] Download mode obtains blob bytes through the GitHub API
[x] Download mode applies existing byte-ceiling and supported media-type policies
[x] Download mode returns the existing binary download metadata structure (local path, content type, size)
[x] Unicode content is decoded correctly
[x] Output goes through the preview/artifact pipeline for text modes
[x] `GITHUB_TOKEN` is confined to fixed GitHub API hosts
[x] Tests cover: public and authenticated text file fetch, raw source, readable text, Unicode content, missing files, unsupported binary blob rejection, supported image/PDF download, byte ceiling enforcement, content-addressed temporary download metadata

### Blocked by

- 0048 — Prefactor: Extract representation pipeline as a deep module
- 0049 — Content artifact persistence and recoverable truncation
- 0052 — GitHub URL recognition and ref/path resolution
