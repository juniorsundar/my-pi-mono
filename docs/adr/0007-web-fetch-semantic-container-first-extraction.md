# Web fetch: semantic container-first HTML extraction

`web_fetch` now extracts HTML content by first looking for a semantic main-content container (`<article>`, `<main>`, or `[role=main]`) and converting it with `markdownify`, falling back to `readability-lxml` only when no such container exists or its output is too short (< 50 chars). This replaces the previous readability-first pipeline, which silently stripped all headings from GitHub READMEs and documentation pages.

## Status

Accepted

## Context

The previous `extract_html()` in `extensions/web-search/scripts/fetch.py` ran every HTML page through `readability-lxml`'s `doc.summary()`, then converted the result with `markdownify`. Readability was designed for news-article extraction; on structured pages (GitHub READMEs, readthedocs/Sphinx docs, wikis) it discards `<h1>`–`<h6>` elements entirely, producing flat, structureless markdown. Empirically, fetching the markdown-oxide GitHub README this way yielded **zero headings** from a page that has eight.

We considered replacing readability with **trafilatura** (the most-recommended alternative, v2.1.0). Empirical testing showed trafilatura preserves headings but mangles GitHub README content badly — entire multi-paragraph sections with code blocks collapsed into single garbled lines (consistent with its open inline-`<code>` duplication bug, [Issue #849](https://github.com/adbar/trafilatura/issues/849)). Trafilatura was rejected.

A third approach was tested: locate the main content container via semantic HTML (`<article>` / `<main>` / `[role=main]`), strip boilerplate and anchor-link icons, then convert with `markdownify`. This preserved all eight headings, all code blocks, lists, and links on both the GitHub README and a readthedocs page — using only dependencies we already have (BeautifulSoup, markdownify).

## Decision

The extraction pipeline becomes two-tier:

1. **Primary — semantic container**: search for `<article>`, then `<main>`, then `[role=main]`. If found, strip boilerplate tags (`script`, `style`, `noscript`, `nav`, `form`, `button`) and heading anchor-icon links, then convert with `markdownify`. **Note**: `<header>` and `<footer>` are intentionally **not** stripped here — the semantic container IS the content boundary, so page-level `<header>`/`<footer>` are already excluded. Stripping them inside the container risks losing article-level headings and metadata.
2. **Fallback — readability**: if no semantic container is found, or the container's extracted text is under 50 chars (reusing the existing "very little content" threshold), fall back to `readability-lxml` + `markdownify` exactly as before.

Heading anchor-link `<a>` tags are stripped when their text content is a decorative glyph (`#`, `¶`, `§`) or empty/whitespace — this is the primary check. The known class set (`anchor`, `headerlink`, `header-anchor`) is checked as a secondary belt-and-suspenders heuristic.

## Considered Options

- **Replace readability with trafilatura.** Rejected: empirically mangles GitHub README content. Added dependency for worse output.
- **Drop readability entirely; fall back to `<body>` with aggressive tag stripping.** Rejected: loses readability's heuristics for the long tail of unstructured pages (blogs, news, forums) with no semantic containers. Keeping readability as fallback covers those cases at no extra cost since it's already a dependency.
- **Run both paths and pick the longer output.** Rejected: doubles extraction cost on every fetch for marginal robustness gain. The quality-based fallback threshold (c) achieves the same safety net cheaply.

## Consequences

- **No new dependencies.** The change uses only `beautifulsoup4`, `markdownify`, and `readability-lxml`, all already declared in `pyproject.toml`. Trafilatura is not added.
- **Existing tests in `tests/test_fetch.py` that assert readability-first behaviour must be updated** for the semantic-container path. New tests should cover: (a) `<article>` extraction preserves headings; (b) fallback to readability when no container exists; (c) fallback to readability when container output is < 50 chars; (d) anchor-link stripping across GitHub and Sphinx class patterns.
- **Sites without any semantic container and with JS-rendered content** still produce the existing "page may require JavaScript" warning via the readability fallback. No regression for that case.