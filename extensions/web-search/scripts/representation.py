"""Representation pipeline for web-fetch.

The pipeline accepts fetched bytes and a representation mode, then returns
source metadata, the available representation, a bounded content preview,
completeness flags, warnings, and an optional content artifact path.

This is a deep module: it hides decoding, readability extraction, character
truncation, and the distinction between preview and source truncation behind
one interface.
"""

from __future__ import annotations

import os
import tempfile
from copy import copy
from dataclasses import dataclass, field
from typing import Dict, List, Literal, Optional, Tuple

from bs4 import BeautifulSoup, Tag
from markdownify import markdownify as md
from readability import Document as ReadabilityDoc

OutputFormat = Literal["markdown", "text", "raw"]
ContentCategory = Literal["html", "text_like", "unsupported"]


# ---------------------------------------------------------------------------
# Pipeline result
# ---------------------------------------------------------------------------

@dataclass
class PipelineResult:
    """Result of running the representation pipeline on fetched bytes.

    Attributes:
        title: Extracted document title, if available.
        content: The representation content (preview or full).
        truncated: Whether content was truncated due to max_chars limit.
        content_artifact_path: Path to a temporary file containing the full
            available representation, or ``None`` if no truncation occurred.
        source_truncated: Whether the source itself was truncated by a
            transport or upstream-service limit (independent of *truncated*).
        content_length: Length of the content string (computed from *content*).
        warnings: Non-fatal warnings from the pipeline.
    """

    title: Optional[str] = None
    content: str = ""
    truncated: bool = False
    content_artifact_path: Optional[str] = None
    source_truncated: bool = False
    warnings: List[str] = field(default_factory=list)

    @property
    def content_length(self) -> int:
        """Length of *content*, always kept in sync."""
        return len(self.content)


# ---------------------------------------------------------------------------
# Content-type helpers
# ---------------------------------------------------------------------------

SUPPORTED_HTML_TYPES = frozenset({
    "text/html",
    "application/xhtml+xml",
})

SUPPORTED_TEXT_TYPES = frozenset({
    "text/plain",
    "text/markdown",
})

SUPPORTED_DATA_TYPES = frozenset({
    "application/json",
    "application/xml",
    "text/xml",
})


def categorize_content(content_type: Optional[str]) -> ContentCategory:
    """Classify a Content-Type string into a pipeline category."""
    if not content_type:
        return "unsupported"
    media_type = content_type.split(";")[0].strip().lower()
    if media_type in SUPPORTED_HTML_TYPES:
        return "html"
    if media_type in SUPPORTED_TEXT_TYPES or media_type in SUPPORTED_DATA_TYPES:
        return "text_like"
    return "unsupported"


# ---------------------------------------------------------------------------
# Body decoding
# ---------------------------------------------------------------------------

def decode_body(body: bytes, content_type: Optional[str]) -> str:
    """Decode bytes to string using charset from Content-Type or UTF-8 fallback."""
    charset = "utf-8"
    if content_type:
        for part in content_type.split(";"):
            part = part.strip()
            if part.lower().startswith("charset="):
                charset = part[8:].strip().strip("'\"")
                break

    try:
        return body.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return body.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# HTML extraction — semantic container helpers
# ---------------------------------------------------------------------------

# Tags to strip from extracted semantic containers.
SemanticStripTags = ["script", "style", "noscript", "nav", "form", "button"]

# Anchor-link classes known to be decorative heading icons (additive).
AnchorClasses: set[str] = {"anchor", "headerlink", "header-anchor"}

# Glyph-only text patterns that indicate decorative anchor links.
AnchorGlyphs: set[str] = {"#", "¶", "§"}


def find_main_container(soup: BeautifulSoup) -> Optional[Tag]:
    """Return the first semantic main-content element, or None.

    Search order: <article>, <main>, [role="main"].
    """
    for selector in ("article", "main"):
        container = soup.find(selector)
        if container is not None:
            return container
    return soup.find(attrs={"role": "main"})


def extract_title(soup: BeautifulSoup, container: Optional[Tag]) -> Optional[str]:
    """Return the document title for the semantic extraction path.

    Search order: ``<title>`` in ``<head>``, then the first heading
    (``<h1>``–``<h6>``) in document order inside *container*, then ``None``.
    """
    head_title = soup.find("title")
    if head_title:
        text = head_title.get_text(strip=True)
        if text:
            return text

    if container is not None:
        heading = container.find(["h1", "h2", "h3", "h4", "h5", "h6"])
        if heading is not None:
            text = heading.get_text(strip=True)
            if text:
                return text

    return None


def strip_boilerplate(container: Tag) -> None:
    """Remove non-content elements from *container* in-place."""
    for tag in container.find_all(SemanticStripTags):
        tag.decompose()


def strip_anchor_links(container: Tag) -> None:
    """Remove decorative heading-anchor links from *container* in-place."""
    for a_tag in container.find_all("a"):
        text = a_tag.get_text(strip=True)
        if text in AnchorGlyphs or text == "":
            a_tag.decompose()
            continue
        classes = set(a_tag.get("class", []))
        if classes & AnchorClasses:
            a_tag.decompose()


# ---------------------------------------------------------------------------
# HTML extraction — readability fallback
# ---------------------------------------------------------------------------

def _extract_via_readability(
    html_text: str,
    url: str,
    output_format: OutputFormat,
) -> Tuple[Optional[str], str, List[str]]:
    """Extract content using readability-lxml (fallback path).

    Returns ``(title, content, warnings)``.
    """
    warnings: List[str] = []

    doc = ReadabilityDoc(html_text, url=url)
    title = doc.short_title() or doc.title() or None
    summary_html = doc.summary()

    soup = BeautifulSoup(summary_html, "lxml")
    for tag in soup.find_all(["script", "style", "noscript", "nav", "footer", "header"]):
        tag.decompose()

    readable_html = str(soup)
    extracted_text = soup.get_text(separator="\n", strip=True)

    if len(extracted_text.strip()) < 50:
        warnings.append(
            "Readability extraction returned very little content; "
            "page may require JavaScript. Falling back to raw HTML text."
        )
        full_soup = BeautifulSoup(html_text, "lxml")
        for tag in full_soup.find_all(["script", "style", "noscript"]):
            tag.decompose()
        body = full_soup.find("body")
        if body:
            extracted_text = body.get_text(separator="\n", strip=True)
        else:
            extracted_text = full_soup.get_text(separator="\n", strip=True)

    if output_format == "markdown":
        try:
            content = md(
                readable_html,
                heading_style="ATX",
                bullets="-",
                strip=["script", "style", "noscript", "nav", "footer", "header"],
            )
            content = _normalize_whitespace(content)
            if len(content.strip()) < 50:
                warnings.append(
                    "Markdown conversion produced minimal output; falling back to plain text."
                )
                content = extracted_text
        except Exception as exc:
            warnings.append(f"Markdown conversion failed: {exc}; using plain text.")
            content = extracted_text
    else:
        content = extracted_text

    return (title, _normalize_whitespace(content), warnings)


# ---------------------------------------------------------------------------
# HTML extraction — main entry point
# ---------------------------------------------------------------------------

def _extract_html(
    html_text: str,
    url: str,
    output_format: OutputFormat,
) -> Tuple[Optional[str], str, List[str]]:
    """Extract readable content from HTML.

    Primary: semantic container (``<article>`` / ``<main>`` / ``[role="main"]``)
    with markdownify conversion.
    Fallback: readability-lxml when no container is found or output is too short.

    Returns ``(title, content, warnings)``.
    """
    warnings: List[str] = []
    full_soup = BeautifulSoup(html_text, "lxml")

    # --- Primary: semantic container extraction ---
    container = find_main_container(full_soup)
    use_readability = False

    if container is not None:
        container = copy(container)
        strip_boilerplate(container)
        strip_anchor_links(container)

        extracted_text = container.get_text(separator="\n", strip=True)
        if len(extracted_text.strip()) < 50:
            warnings.append(
                "Semantic container contained very little text; "
                "falling back to readability extraction."
            )
            use_readability = True
    else:
        use_readability = True

    if use_readability:
        return _extract_via_readability(html_text, url, output_format)

    title = extract_title(full_soup, container)

    if output_format == "markdown":
        try:
            content = md(
                str(container),
                heading_style="ATX",
                bullets="-",
                strip=["script", "style", "noscript", "nav", "footer", "header"],
            )
            content = _normalize_whitespace(content)
            if len(content.strip()) < 50:
                warnings.append(
                    "Markdown conversion produced minimal output; falling back to plain text."
                )
                content = extracted_text
        except Exception as exc:
            warnings.append(f"Markdown conversion failed: {exc}; using plain text.")
            content = extracted_text
    else:
        content = extracted_text

    return (title, _normalize_whitespace(content), warnings)


# ---------------------------------------------------------------------------
# Text-like extraction
# ---------------------------------------------------------------------------

def _extract_text_like(
    text: str,
    content_type: Optional[str],
    output_format: OutputFormat,
) -> Tuple[Optional[str], str, List[str]]:
    """Extract content from plain text, markdown, JSON, or XML responses.

    Returns ``(title, content, warnings)``.
    """
    title: Optional[str] = None
    warnings: List[str] = []
    content = text
    media_type = (content_type or "").split(";")[0].strip().lower()

    if media_type == "application/json":
        try:
            import json
            parsed = json.loads(text)
            content = json.dumps(parsed, indent=2, ensure_ascii=False)
        except json.JSONDecodeError:
            content = text
            warnings.append("Content type is JSON but body is not valid JSON; returning raw text.")

    if media_type in ("application/xml", "text/xml"):
        content = _normalize_whitespace(text)

    if media_type == "text/markdown" and output_format == "text":
        soup = BeautifulSoup(f"<pre>{text}</pre>", "lxml")
        content = soup.get_text(separator="\n", strip=True)

    return (title, _normalize_whitespace(content), warnings)


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

def _normalize_whitespace(text: str) -> str:
    """Collapse excessive blank lines and trim trailing whitespace."""
    lines = text.splitlines()
    result: List[str] = []
    blank_count = 0
    for line in lines:
        stripped = line.rstrip()
        if stripped:
            result.append(stripped)
            blank_count = 0
        else:
            blank_count += 1
            if blank_count <= 2:
                result.append("")
    while result and result[0] == "":
        result.pop(0)
    while result and result[-1] == "":
        result.pop()
    return "\n".join(result)


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------

def _truncate(text: str, max_chars: int) -> Tuple[str, bool]:
    """Truncate *text* to *max_chars*, returning ``(truncated_text, was_truncated)``."""
    max_chars = max(1_000, min(max_chars, 100_000))
    if len(text) <= max_chars:
        return text, False
    truncated = text[:max_chars]
    last_newline = truncated.rfind("\n")
    if last_newline > max_chars // 2:
        truncated = text[:last_newline]
    truncated += (
        f"\n\n[... Content truncated at {max_chars} characters. "
        f"Total document length: {len(text)} characters. "
        f"Use --max-chars to increase limit up to 100,000.]"
    )
    return truncated, True


# ---------------------------------------------------------------------------
# Public API: process()
# ---------------------------------------------------------------------------

def _write_content_artifact(full_content: str, output_format: OutputFormat) -> str:
    """Write *full_content* to a temporary file and return its absolute path.

    The file uses a ``.md`` or ``.txt`` extension matching *output_format*.
    """
    suffix = ".md" if output_format == "markdown" else ".txt"
    fd, path = tempfile.mkstemp(suffix=suffix, prefix="pi-web-fetch-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(full_content)
    except Exception:
        os.unlink(path)
        raise
    return path


def process(
    body: bytes,
    content_type: Optional[str],
    url: str,
    output_format: OutputFormat,
    max_chars: int,
    source_truncated: bool = False,
    raw: bool = False,
) -> PipelineResult:
    """Run the full representation pipeline on fetched bytes.

    Accepts raw bytes, detects encoding, categorizes content type,
    extracts the appropriate representation (HTML or text-like), truncates
    to *max_chars*, and returns the result with completeness flags.

    When truncation occurs, the full available representation is written
    to an ephemeral temp file whose path is returned in
    ``content_artifact_path``.

    Args:
        body: Raw response bytes from the HTTP fetch.
        content_type: Content-Type header value (may include charset).
        url: The original URL (used for contextual extraction decisions).
        output_format: ``"markdown"`` or ``"text"``.
        max_chars: Character limit for the content preview.
        source_truncated: Whether the source was truncated by a transport
            or upstream limit.
        raw: If true, skip readability extraction and return the decoded body
            as-is. When raw is true, *output_format* is ignored.

    Returns:
        A :class:`PipelineResult` with the extracted representation.
    """
    # 1. Decode bytes to string
    text = decode_body(body, content_type)

    # 2. Categorize and extract
    if raw:
        # Raw mode: skip all extraction, return decoded body as-is
        title = None
        warnings: List[str] = []
        content = text
    else:
        category = categorize_content(content_type)

        if category == "html":
            title, content, warnings = _extract_html(text, url, output_format)
        else:
            title, content, warnings = _extract_text_like(text, content_type, output_format)

    # 3. Save full content before truncation
    full_content = content

    # 4. Truncate
    content, truncated = _truncate(content, max_chars)

    # 5. Write content artifact if truncated
    content_artifact_path: Optional[str] = None
    if truncated:
        content_artifact_path = _write_content_artifact(full_content, output_format)

    return PipelineResult(
        title=title,
        content=content,
        truncated=truncated,
        content_artifact_path=content_artifact_path,
        source_truncated=source_truncated,
        warnings=warnings,
    )
