# Spec: Recoverable Web Fetches and GitHub Resources

### Problem Statement

The `web_fetch` tool produces useful readable representations of public web resources, but several cases remain lossy or misleading.

When a fetched representation exceeds the inline character limit, the tool returns only a truncated content preview. The omitted content is discarded, so an agent cannot inspect it without repeating the request with a larger limit, and content beyond the maximum preview size is unreachable. The existing `truncated` field also does not distinguish recoverable preview truncation from source truncation caused by a transport or upstream-service limit.

The tool always applies readability extraction or text normalization. An agent cannot request raw source when it needs original HTML, JSON-LD, metadata, attributes, or another source-level detail that extraction removes.

Finally, repository, directory, and file URLs on GitHub are treated as ordinary web pages. Generic HTML extraction can return GitHub application chrome rather than the repository structure or file content the URL identifies. This is especially limiting for private repositories and branch or tag names containing `/`.

These capabilities must be added without replacing the existing TypeScript-to-Python wrapper strategy, weakening public-web SSRF protections, exposing GitHub credentials, or regressing binary image and PDF downloads.

### Solution

Extend `web_fetch` with three coordinated capabilities:

1. Preserve the complete available representation as a private, ephemeral content artifact whenever the inline content preview is truncated. Return its path as `contentArtifactPath` so the agent can inspect omitted content with the read tool.
2. Add `raw: true` as a text-source extraction bypass. Raw mode returns decoded source through the same bounded preview and content-artifact pipeline and reports `format: "raw"`.
3. Automatically recognize GitHub repository, tree, and blob URLs as GitHub resources. Resolve them through a dedicated Python GitHub module using only fixed `api.github.com` requests, optional `GITHUB_TOKEN` authentication, explicit limits, and structured failures. Repository and tree resources return bounded recursive trees; blob resources return file content or support authenticated binary download.

Preview truncation and source truncation become separate concepts. `truncated` means the returned preview omits part of an available representation and therefore has a recoverable content artifact. `sourceTruncated` means a transport or upstream limit prevented the available representation itself from being complete; a content artifact cannot restore source content that was never obtained.

Implementation proceeds in two tested slices: first the generic fetch representation pipeline, then GitHub specialization.

### User Stories

1. As a coding agent, I want a bounded content preview, so that a large fetched document does not overwhelm my context window.
2. As a coding agent, I want omitted preview content preserved in a content artifact, so that I can inspect the complete available representation without repeating the network request.
3. As a coding agent, I want the content artifact path returned in tool output and result details, so that I can pass it directly to the read tool.
4. As a coding agent, I want the content artifact to contain the same representation as the preview, so that continuing from the artifact does not unexpectedly switch from Markdown to HTML or from normalized text to response bytes.
5. As a coding agent, I want content artifacts created only when previews are truncated, so that ordinary fetches do not create unnecessary files.
6. As a user, I want content artifacts stored as private mode-0600 files, so that fetched private source is not exposed to other local users.
7. As a user, I want content artifacts to be ephemeral OS-temporary files, so that the extension does not create a persistent cache of potentially sensitive web content.
8. As a coding agent, I want `truncated` to mean recoverable preview truncation, so that I know a content artifact contains the omitted representation.
9. As a coding agent, I want `sourceTruncated` to identify an incomplete source representation, so that I do not mistake an artifact for a complete document.
10. As a coding agent, I want a clear warning when source truncation may leave HTML or structured data incomplete, so that I interpret extraction results cautiously.
11. As a coding agent, I want responses that reach the network byte ceiling to return the safely bounded bytes already obtained, so that a large source remains partially useful rather than failing completely.
12. As a user, I want the network byte ceiling retained, so that oversized or unbounded responses cannot consume arbitrary memory or disk.
13. As a coding agent, I want to request `raw: true`, so that I can inspect source details removed by readability extraction.
14. As a coding agent, I want raw mode to return decoded response source, so that HTML, JSON, XML, Markdown, and plain-text bodies remain directly inspectable.
15. As a coding agent, I want raw mode to report `format: "raw"`, so that I can distinguish original decoded source from a readable representation.
16. As a coding agent, I want raw source to use the same preview limit and artifact behavior as readable content, so that raw mode remains context-safe.
17. As a coding agent, I want raw mode limited to text-like responses, so that binary data is not returned as corrupted text.
18. As a coding agent, I want binary files handled through `download: true`, so that byte-oriented and text-oriented operations remain explicit.
19. As a coding agent, I want simultaneous `raw: true` and `download: true` rejected, so that the requested representation is never ambiguous.
20. As a coding agent, I want existing Markdown and text output modes preserved, so that current readable-fetch workflows continue to work.
21. As a coding agent, I want image and PDF download behavior preserved, so that fetched binary files can still be handed to multimodal tools.
22. As a coding agent, I want `download` explicitly present in the tool parameter schema, so that the model can invoke the already-described binary-download capability reliably.
23. As a coding agent, I want a GitHub repository URL interpreted as a repository resource, so that I receive repository metadata and structure rather than GitHub page chrome.
24. As a coding agent, I want a GitHub tree URL interpreted as a directory resource, so that I receive descendant paths under the requested directory.
25. As a coding agent, I want a GitHub blob URL interpreted as a file resource, so that I receive the identified file content.
26. As a coding agent, I want GitHub specialization enabled automatically, so that I do not need a separate configuration step to obtain the representation named by the URL.
27. As a coding agent, I want only repository, tree, and blob URL families specialized initially, so that issues, pull requests, releases, commits, gists, and unrelated GitHub pages retain ordinary fetch behavior.
28. As a coding agent, I want GitHub branches and tags containing `/` resolved correctly, so that valid tree and blob URLs are not split at the wrong path segment.
29. As a coding agent, I want the longest valid GitHub ref prefix selected, so that ref/path ambiguity is resolved deterministically.
30. As a coding agent, I want repository-root URLs resolved against the repository's default branch, so that root fetches require no branch knowledge.
31. As a coding agent, I want repository and directory resources represented as deterministic, sorted recursive trees, so that repeated calls are easy to compare and reason about.
32. As a coding agent, I want recursive GitHub trees bounded at 2,000 entries, so that large repositories remain safe to process.
33. As a coding agent, I want trees exceeding the bound returned as partial trees with `sourceTruncated: true`, so that the available structure remains useful without being described as complete.
34. As a coding agent, I want upstream GitHub tree truncation surfaced as source truncation, so that GitHub's incomplete response is not mistaken for a complete repository map.
35. As a coding agent, I want GitHub tree readable representations to honor `format: "markdown"` and `format: "text"`, so that specialization respects the existing fetch contract.
36. As a coding agent, I want GitHub tree raw mode to return its canonical API source representation, so that I can inspect the specialist's unformatted data when needed.
37. As a coding agent, I want GitHub blob raw mode to return decoded file source, so that source files remain useful without readability processing.
38. As a coding agent, I want binary GitHub blobs rejected in readable and raw modes, so that binary bytes are not silently decoded as text.
39. As a coding agent, I want `download: true` on a supported binary GitHub blob to save the blob bytes, so that private images and PDFs can be inspected without finding a separate raw URL.
40. As a user, I want public GitHub resources to work without configuration, so that anonymous API access remains frictionless.
41. As a user, I want `GITHUB_TOKEN` used when present, so that private repositories and higher authenticated rate limits are available.
42. As a user, I want GitHub credentials sent only to `api.github.com`, so that a URL or API metadata value cannot redirect my token to another host.
43. As a user, I want the specialist to construct API requests from validated owner, repository, ref, and path values, so that a supplied URL cannot choose an arbitrary request host.
44. As a user, I want the specialist to avoid API-provided arbitrary download URLs, so that authenticated blob downloads remain inside the fixed GitHub API host policy.
45. As a coding agent, I want recognized GitHub resolution failures returned explicitly, so that missing, unauthorized, rate-limited, and oversized resources are not hidden by generic HTML fallback.
46. As a coding agent, I want GitHub rate-limit failures to include actionable status and reset metadata, so that I can explain whether waiting or adding authentication is required.
47. As a coding agent, I want GitHub failures to indicate whether authentication was used without exposing the token, so that configuration problems can be diagnosed safely.
48. As a user, I want GitHub rate-limit failures returned immediately without automatic retry, so that exhausted limits do not add pointless latency.
49. As a user, I want generic public-web URL and redirect validation retained, so that adding GitHub specialization does not weaken SSRF protections.
50. As a maintainer, I want GitHub specialization isolated behind a small Python interface, so that parsing, ref resolution, API interaction, tree bounding, and blob decoding remain local to one deep module.
51. As a maintainer, I want the existing Python-script architecture preserved, so that HTTP and extraction behavior remains in the Python environment and the TypeScript layer stays an adapter for Pi.
52. As a maintainer, I want generic representation and artifact handling shared by ordinary and GitHub fetches, so that preview limits, metadata, and file behavior do not diverge.
53. As a maintainer, I want tests to exercise observable tool and CLI behavior, so that internal refactoring does not require rewriting behavior specifications.
54. As a maintainer, I want all remote HTTP tests to use controlled adapters or mocks, so that the suite is deterministic and does not consume live SearXNG or GitHub quotas.
55. As a maintainer, I want the work split into two independently green slices, so that generic fetch semantics stabilize before GitHub specialization is introduced.

### Implementation Decisions

- **Preserve the Python wrapper architecture.** Pi continues to invoke a Python CLI through the TypeScript extension. The TypeScript module remains a thin adapter responsible for the tool schema, subprocess execution, progress/result formatting, and result details. HTTP fetching, extraction, artifact creation, and GitHub specialization remain in Python.

- **Introduce a representation pipeline as a deep module.** The representation pipeline accepts fetched bytes and representation mode, then returns source metadata, the available representation, a bounded content preview, completeness flags, warnings, and an optional content artifact path. It hides decoding, readability extraction, raw bypass, character truncation, artifact creation, and the distinction between preview and source truncation behind one interface.

- **Keep fetch modes explicit and mutually exclusive.** The modes are readable, raw source, and binary download. Readable mode honors `format: "markdown" | "text"`. Raw mode is selected with `raw: true`, ignores the readable `format` selection, and reports `format: "raw"`. Download mode is selected with `download: true`. Supplying raw and download together returns a controlled validation error.

- **Expose binary download in the formal tool schema.** `download` becomes an optional boolean parameter rather than existing only in descriptions and internal TypeScript plumbing. Existing image and PDF allowlists and download metadata remain supported.

- **Define preview truncation as recoverable.** `truncated: true` means the inline content preview is shorter than the available representation. Whenever it is true, `contentArtifactPath` is present and points to the complete available representation. When it is false, no content artifact is written.

- **Define source truncation independently.** `sourceTruncated: true` means the representation is incomplete because a transport or upstream-service limit prevented the remainder from being obtained. It does not imply that a content artifact exists. If both flags are true, the artifact contains the complete available representation, not the unavailable source remainder.

- **Clarify length metadata.** `contentLength` describes the character length of the complete available representation before preview clipping. `fetchedBytes` describes bytes accepted from the source. The inline content field itself determines preview length. Warnings explain when source truncation may leave markup or structured content incomplete.

- **Return bounded partial network responses.** The HTTP fetcher streams response bytes and stops at the byte ceiling rather than buffering an unbounded response or failing after exceeding the limit. The accepted bytes continue through decoding and representation. The result sets `sourceTruncated: true`. Partial structured data that cannot be normalized is returned through a safe textual fallback with a warning.

- **Create private content artifacts in Python.** Because Python owns the complete available representation before preview clipping, it creates artifacts directly. Files are created in the operating system's temporary directory with mode 0600, use an unambiguous text extension, and are left to operating-system cleanup. Artifact names must not contain URL secrets or private repository names. The result exposes `contentArtifactPath` but does not treat it as a binary download.

- **Preserve current readable extraction.** Semantic-container-first extraction remains primary, with readability fallback for pages lacking useful semantic containers. Raw mode bypasses both extraction tiers and whitespace normalization that would alter source fidelity.

- **Add a dedicated GitHub resource module.** The module has a narrow interface accepting a parsed fetch request and returning either a fetched representation envelope or a structured GitHub resolution failure. Its implementation hides GitHub URL recognition, owner/repository validation, default-branch lookup, ref/path disambiguation, API request construction, tree filtering and bounding, blob decoding, token handling, and GitHub-specific error mapping.

- **Treat GitHub as a true external dependency.** Production uses an HTTP adapter restricted to GitHub's API host. Tests use a controlled mock adapter at the module's internal seam. The external tool and CLI interfaces do not expose transport details.

- **Enable GitHub specialization automatically.** No setting or interactive opt-in is introduced. URLs recognized as GitHub repository, tree, or blob resources are owned by the specialist. Other GitHub URL families and non-GitHub URLs continue through generic fetching.

- **Recognize a narrow URL set.** The specialist recognizes canonical GitHub repository roots and their `/tree/` and `/blob/` forms. It accepts the conventional `www` hostname alias. Issues, pull requests, releases, commits, compare views, actions, gists, raw-content hosts, and other GitHub routes are not claimed by the specialist.

- **Resolve ambiguous refs through GitHub.** For tree and blob URLs, the specialist evaluates candidate prefixes and chooses the longest prefix that resolves to a valid branch, tag, or commit. This supports slash-containing branch and tag names while keeping the remaining suffix as the resource path. Resolution is bounded and rejects pathological inputs rather than issuing unbounded requests.

- **Use fixed GitHub API requests.** All authenticated specialist traffic is constructed against `https://api.github.com` from validated identifiers. The specialist does not follow metadata-provided arbitrary download URLs and does not forward credentials outside the fixed host. API redirects, if accepted at all, must remain subject to the same fixed-host policy.

- **Use optional environment authentication.** When `GITHUB_TOKEN` is present, the specialist adds it to GitHub API requests. When absent, public repositories use anonymous access. Result details may report whether authentication was used but must never expose credential values or include them in artifact names, warnings, URLs, or errors.

- **Return deterministic GitHub trees.** Repository roots resolve through the default branch. Tree URLs resolve through their identified ref and requested directory. Readable output contains repository metadata and lexicographically sorted descendant paths under the requested root. Markdown mode uses structured metadata plus a fenced path listing; text mode uses plain metadata and paths.

- **Bound GitHub tree representations.** A tree contains at most 2,000 displayed entries. If the specialist's bound or GitHub's own recursive-tree limit is reached, it returns a partial tree, sets `sourceTruncated: true`, and emits an explicit warning. A content artifact may preserve the entire available partial tree when its preview is clipped, but it must never claim to restore the missing descendants.

- **Define GitHub raw representations.** Raw mode still routes through the specialist. Blob resources return decoded file source without readability extraction. Repository and tree resources return the canonical GitHub API JSON representation used by the specialist, bounded by the ordinary preview/artifact pipeline.

- **Keep binary GitHub resources byte-oriented.** Readable and raw blob fetches reject detected binary content with guidance to use download mode. Download mode obtains blob bytes through fixed-host GitHub API responses, applies the existing maximum-byte and supported media-type policies, and returns the existing binary download metadata.

- **Do not fall back after recognized GitHub failures.** Once a URL is recognized as a GitHub resource, missing, unauthorized, forbidden, rate-limited, malformed, oversized, or otherwise unresolved resources return structured GitHub resolution failures. Generic GitHub HTML extraction is not attempted.

- **Make GitHub rate limits actionable.** Rate-limit failures return HTTP status, remaining quota when available, reset time when available, and whether authentication was used. They are returned immediately without automatic retry.

- **Retain generic public-web safety controls.** Generic fetching continues to allow only HTTP and HTTPS, reject embedded credentials and non-public address resolution, cap redirects and bytes, and validate redirect destinations. GitHub specialization does not weaken or bypass those rules; it narrows its own network access further through a fixed API host.

- **Implement in two slices.** Slice one delivers content artifacts, raw mode, explicit download schema, streaming byte-ceiling behavior, and distinct truncation flags for generic fetching. Slice two adds the GitHub resource module and integrates its representations into the same preview and artifact pipeline.

- **Defer configurable guidance and interactive setup.** No configuration command, guidance override, provider picker, or GitHub enable flag is introduced. The concrete value of those features does not currently justify their configuration and maintenance surface.

### Testing Decisions

- **Test through interfaces.** Good tests provide a request and controlled remote response, then assert the resulting content, metadata, files, or structured failure. They do not assert private helper call order, parser implementation, temporary variable values, or the exact internal composition of modules.

- **Test the Python CLI as the main behavior surface.** Existing pytest and mocked-HTTP patterns remain the primary prior art. CLI tests cover argument validation, JSON envelopes, exit codes, readable/raw/download mode selection, subprocess-compatible stdout behavior, and controlled failures.

- **Test the representation pipeline directly where behavior is otherwise difficult to isolate.** Tests cover Markdown, text, and raw representations; exact preview clipping; natural-boundary clipping; artifact creation only on clipping; artifact contents matching the complete available representation; mode-0600 permissions; and artifact names excluding source identifiers.

- **Test independent completeness flags.** Cases cover preview-only truncation, source-only truncation, both flags together, and neither flag. Tests verify that only preview truncation requires `contentArtifactPath`, and that artifacts never claim unavailable source content.

- **Test streaming byte limits externally.** A mocked response larger than the byte ceiling must stop consumption, return the accepted partial representation, set `sourceTruncated: true`, and remain within the bound. Partial HTML, JSON, XML, and multibyte text cases must produce safe output and warnings rather than crashes or falsely complete documents.

- **Test raw mode behavior.** Raw HTML preserves tags, attributes, metadata, scripts, and source whitespace that readable extraction would remove. Raw JSON and XML remain decoded source rather than pretty-printed or normalized output. Raw responses report `format: "raw"` and use ordinary preview/artifact behavior.

- **Test mode conflicts and content categories.** Raw plus download returns a controlled error. Raw binary responses are rejected. Existing readable text-like handling and image/PDF download behavior remain green. The model-facing schema includes both raw and download parameters.

- **Test the TypeScript adapter.** Add tests for parameter forwarding, timeout selection, schema exposure, result formatting, `contentArtifactPath`, `sourceTruncated`, `format: "raw"`, warnings, and slash-command argument handling. Subprocess and filesystem effects remain mocked at this layer because their behavior is tested in Python.

- **Test GitHub URL recognition comprehensively.** Cases cover repository roots, `www` aliases, trees, blobs, percent-encoded paths, `.git` suffixes, malformed paths, and explicit non-specialized routes such as issues, pull requests, releases, commits, gists, and raw-content hosts.

- **Test GitHub ref/path resolution externally.** Mocked API responses cover simple branches, tags, commit SHAs, slash-containing refs, longest-valid-prefix selection, invalid refs, and bounded rejection of pathological candidates.

- **Test GitHub repository and tree behavior.** Cases cover default-branch resolution, requested subdirectories, deterministic sorting, Markdown and text rendering, raw JSON rendering, empty trees, exactly 2,000 entries, more than 2,000 entries, and upstream-truncated trees. Partial trees must set source truncation and explicit warnings.

- **Test GitHub blobs and downloads.** Cases cover public and authenticated text files, raw source, readable text, Unicode content, missing files, unsupported binary blobs, supported image/PDF downloads, byte ceilings, and content-addressed temporary download metadata.

- **Test credential confinement.** Tests verify that `GITHUB_TOKEN` is sent only to fixed GitHub API requests, never appears in outputs or artifacts, and is not forwarded to metadata-provided URLs. Requests attempting to influence host selection must fail before network access.

- **Test structured GitHub failures.** Cases cover unauthenticated not-found, authenticated not-found, unauthorized, forbidden, rate-limited, malformed JSON, unexpected media, and server errors. Rate-limit output includes available reset/quota metadata and does not retry or fall back to HTML.

- **Test integration ordering.** Recognized GitHub resources use the specialist automatically; recognized failures remain specialist failures; non-specialized GitHub routes and ordinary public URLs use generic fetching. All resulting text representations pass through the same preview and artifact behavior.

- **Keep tests offline and deterministic.** No test calls live GitHub, SearXNG, or arbitrary public sites. HTTP behavior uses mock adapters, and temporary-file tests use isolated temporary directories.

- **Run the full existing fetch/search suite after each slice.** Slice one must be fully green before slice two begins. The completed feature must preserve all existing search normalization, readable extraction, SSRF, MIME, and binary-download tests.

### Out of Scope

- Replacing the Python scripts with an in-process TypeScript HTTP or extraction implementation
- Adding additional search providers or changing SearXNG search behavior
- Interactive configuration commands
- Configurable `promptSnippet` or `promptGuidelines`
- A GitHub specialist enable/disable setting
- Git clone or `gh` CLI integration
- Persistent repository clones or GitHub response caching
- GitHub issues, pull requests, commits, releases, compare views, actions, wikis, gists, or raw-content-host specialization
- Silent fallback from a recognized GitHub resource to ordinary GitHub HTML
- Automatic retries for GitHub rate limits or server failures
- Guaranteed complete traversal of GitHub repositories larger than the recursive-tree limits
- Returning arbitrary binary responses as decoded raw text
- Expanding binary download support beyond the existing intentional image and PDF allowlist
- JavaScript execution or browser automation for client-rendered pages
- Persistent content-artifact storage, retention configuration, or cross-session artifact indexes
- Restoring source content that was never obtained because of transport or upstream limits
- Changing `web_search` tool names, parameters, result enrichment, or SearXNG configuration

### Further Notes

- The canonical distinction is between a content preview, a content artifact, and source truncation. A content artifact recovers content omitted only from the preview; it cannot make an incomplete source complete.
- `raw` means decoded text source, not arbitrary bytes and not binary download. This distinction should be preserved in descriptions, warnings, tests, and result formatting.
- The GitHub module is intended to be deep: callers provide a fetch request and receive a representation or structured failure without learning GitHub URL grammar, ref disambiguation, tree APIs, base64 decoding, authentication headers, or rate-limit semantics.
- The existing semantic-container-first extraction decision remains in force for readable HTML. GitHub specialization does not replace that extractor for ordinary pages or non-specialized GitHub routes.
- The existing SearXNG decision remains unchanged. GitHub specialization is part of fetching a selected resource, not a search-backend feature.
- No new ADR is required at Spec creation time. The Python wrapper is an existing constraint, and the two proposed modules remain reversible implementation choices. If authenticated fixed-host specialization later becomes a shared platform for multiple hosts, that broader seam may warrant an ADR.
