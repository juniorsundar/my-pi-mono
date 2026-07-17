"""Tests for the representation pipeline module.

The pipeline accepts fetched bytes and a representation mode, then returns
source metadata, the available representation, a bounded content preview,
completeness flags, warnings, and an optional content artifact path.
"""

from __future__ import annotations

import os
import tempfile

from representation import PipelineResult, process, OutputFormat


# ===========================================================================
# Tracer bullet: process() exists and returns PipelineResult
# ===========================================================================

class TestProcessTracerBullet:
    """The tracer bullet proves the pipeline module and process() work end-to-end."""

    def test_returns_pipeline_result_with_decoded_content(self):
        """process() returns a PipelineResult with decoded text content."""
        result = process(
            body=b"Hello, world!",
            content_type="text/plain; charset=utf-8",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert isinstance(result, PipelineResult)
        assert result.content == "Hello, world!"
        assert result.truncated is False
        assert result.content_length == 13
        assert result.warnings == []
        assert result.title is None


# ===========================================================================
# Text-like extraction (plain text, JSON, XML, markdown)
# ===========================================================================

class TestTextLikeExtraction:
    """The pipeline extracts content from plain text, JSON, XML, and markdown."""

    def test_plain_text_is_preserved(self):
        """Plain text content is passed through unchanged."""
        result = process(
            body=b"Hello, world!",
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "Hello, world!"

    def test_json_is_pretty_printed(self):
        """JSON content is pretty-printed with indent."""
        result = process(
            body=b'{"name": "test", "value": 42}',
            content_type="application/json",
            url="https://example.com/data",
            output_format="text",
            max_chars=100_000,
        )
        assert '"name": "test"' in result.content
        assert '"value": 42' in result.content

    def test_invalid_json_falls_back_to_raw_text(self):
        """Invalid JSON returns raw text with a warning."""
        result = process(
            body=b"not valid json",
            content_type="application/json",
            url="https://example.com/data",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "not valid json"
        assert any("not valid JSON" in w for w in result.warnings)

    def test_xml_is_preserved(self):
        """XML content is preserved with whitespace normalized."""
        result = process(
            body=b"<root>\n  <item>value</item>\n</root>",
            content_type="application/xml",
            url="https://example.com/data",
            output_format="text",
            max_chars=100_000,
        )
        assert "<item>value</item>" in result.content

    def test_markdown_to_text_conversion(self):
        """Markdown is converted to plain text when output_format=text."""
        result = process(
            body=b"# Title\n\nSome **bold** text.",
            content_type="text/markdown",
            url="https://example.com/doc",
            output_format="text",
            max_chars=100_000,
        )
        assert "Title" in result.content
        assert "bold" in result.content


FIXTURE_ARTICLE_HTML = """\
<html>
<head><title>Test README</title></head>
<body>
<nav>Site Menu</nav>
<article>
<h1>Project Name</h1>
<p>Description of the project.</p>
<h2>Getting Started</h2>
<p>Run the following:</p>
<pre><code>npm install</code></pre>
<h2>Configuration</h2>
<p>Edit your config.</p>
</article>
<footer>Site Footer</footer>
</body>
</html>
"""


# ===========================================================================
# Readable HTML extraction (semantic container first)
# ===========================================================================

class TestHtmlExtraction:
    """The pipeline extracts readable markdown from HTML via semantic container."""

    def test_semantic_container_extracts_headings(self):
        """Article with h1/h2 headings produces markdown with ATX headings."""
        result = process(
            body=FIXTURE_ARTICLE_HTML.encode("utf-8"),
            content_type="text/html; charset=utf-8",
            url="https://example.com/readme",
            output_format="markdown",
            max_chars=100_000,
        )
        assert "# Project Name" in result.content
        assert "## Getting Started" in result.content
        assert "## Configuration" in result.content
        assert "npm install" in result.content
        assert "Description of the project" in result.content
        # Site chrome should be stripped
        assert "Site Menu" not in result.content
        assert "Site Footer" not in result.content

    def test_semantic_container_extracts_title(self):
        """Title is extracted from <title> for HTML content."""
        result = process(
            body=FIXTURE_ARTICLE_HTML.encode("utf-8"),
            content_type="text/html; charset=utf-8",
            url="https://example.com/readme",
            output_format="markdown",
            max_chars=100_000,
        )
        assert result.title == "Test README"

    def test_no_semantic_container_falls_back_to_readability(self):
        """HTML without article/main/role=main uses readability-lxml fallback."""
        html = b"""<html><head><title>Blog Post</title></head><body><div class="post"><h1>My Blog Post</h1><p>Some interesting content here.</p></div></body></html>"""
        result = process(
            body=html,
            content_type="text/html; charset=utf-8",
            url="https://example.com/blog",
            output_format="markdown",
            max_chars=100_000,
        )
        # Should not crash and should produce some content
        assert result.content is not None
        assert len(result.content) > 0

    def test_empty_article_falls_back_to_readability(self):
        """Article with too-short output (< 50 chars) falls back to readability."""
        html = b"""<html><head><title>Test</title></head><body><article><p>Hi</p></article></body></html>"""
        result = process(
            body=html,
            content_type="text/html; charset=utf-8",
            url="https://example.com/test",
            output_format="markdown",
            max_chars=100_000,
        )
        assert result.content is not None
        assert len(result.content) > 0


# ===========================================================================
# Encoding detection
# ===========================================================================

class TestEncodingDetection:
    """The pipeline detects encoding from Content-Type charset."""

    def test_utf8_default_when_no_charset(self):
        """No charset in Content-Type defaults to UTF-8."""
        result = process(
            body="café résumé".encode("utf-8"),
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "café résumé"

    def test_explicit_utf8_charset(self):
        """charset=utf-8 in Content-Type is respected."""
        result = process(
            body="café résumé".encode("utf-8"),
            content_type="text/html; charset=utf-8",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "café résumé"

    def test_latin1_charset(self):
        """charset=iso-8859-1 is respected for Latin-1 content."""
        body = "Café résumé naïve".encode("iso-8859-1")
        result = process(
            body=body,
            content_type="text/html; charset=iso-8859-1",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "Café résumé naïve"

    def test_fallback_on_wrong_charset(self):
        """A declared charset that doesn't match the bytes falls back to UTF-8."""
        # These bytes are valid UTF-8 but declared as iso-8859-1
        body = "Hello 🌍 world".encode("utf-8")
        result = process(
            body=body,
            content_type="text/plain; charset=iso-8859-1",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        # Should fall back to UTF-8 with replacement chars for actual mismatch
        assert "Hello" in result.content
        assert len(result.content) > 0

    def test_unknown_charset_lookup_error(self):
        """An unrecognised charset (LookupError) falls back to UTF-8."""
        body = "Hello world".encode("utf-8")
        result = process(
            body=body,
            content_type="text/plain; charset=x-unknown-encoding",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "Hello world"


# ===========================================================================
# Truncation
# ===========================================================================

class TestTruncation:
    """The pipeline truncates content at the max_chars boundary."""

    def test_short_content_not_truncated(self):
        """Content under max_chars is not truncated."""
        result = process(
            body=b"Short text.",
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content == "Short text."
        assert result.truncated is False

    def test_long_content_truncated(self):
        """Content over max_chars is truncated with a message."""
        body = "A" * 2000
        result = process(
            body=body.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=1000,
        )
        assert result.truncated is True
        assert "Content truncated" in result.content
        assert len(result.content) < 2000

    def test_truncation_message_appended(self):
        """Truncated content includes the standard truncation notice."""
        body = "A" * 2000
        result = process(
            body=body.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=1000,
        )
        assert "[... Content truncated at 1000 characters." in result.content
        assert "Total document length: 2000 characters." in result.content
        assert "Use --max-chars to increase limit up to 100,000." in result.content

    def test_max_chars_clamped_to_minimum(self):
        """max_chars below 1000 is clamped to 1000."""
        body = "A" * 5000
        result = process(
            body=body.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100,  # Below minimum
        )
        # Should be clamped to 1000 minimum
        assert result.truncated is True
        assert "Content truncated at 1000 characters." in result.content


# ===========================================================================
# Metadata propagation
# ===========================================================================

class TestMetadataPropagation:
    """Pipeline metadata (title, flags, warnings) flows through correctly."""

    def test_title_propagates_for_html(self):
        """Title extracted from HTML is available on PipelineResult."""
        result = process(
            body=b"<html><head><title>My Page</title></head><body><article><p>Content</p></article></body></html>",
            content_type="text/html",
            url="https://example.com",
            output_format="markdown",
            max_chars=100_000,
        )
        assert result.title == "My Page"

    def test_title_is_none_for_text(self):
        """Title is None for text content."""
        result = process(
            body=b"Just text",
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.title is None

    def test_content_length_matches_content(self):
        """content_length reflects the actual content length."""
        body = "Hello, world! " * 10
        result = process(
            body=body.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert result.content_length == len(result.content)

    def test_warnings_propagate_from_extraction(self):
        """Warnings from the extraction step are propagated."""
        result = process(
            body=b"not valid json",
            content_type="application/json",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
        )
        assert len(result.warnings) > 0
        assert any("not valid JSON" in w for w in result.warnings)


# ===========================================================================
# Content artifact (tracer bullet)
# ===========================================================================

class TestContentArtifact:
    """Content artifacts are written when the preview is truncated."""

    def test_artifact_written_when_truncated(self):
        """When content exceeds max_chars, an artifact file is written with the full content."""
        # Generate text that will exceed max_chars after pipeline normalization
        text_line = "Line of text for the content artifact test. "
        raw_text = text_line * 200  # ~10k chars, well over 5k
        body = raw_text.encode("utf-8")

        # Run with truncation to get the artifact
        result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/long.txt",
            output_format="text",
            max_chars=5000,
        )

        assert result.truncated is True
        assert result.content_artifact_path is not None
        assert os.path.exists(result.content_artifact_path)

        # Run without truncation to get the full normalized content
        full_result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/long.txt",
            output_format="text",
            max_chars=100_000,  # well over the expected length
        )

        assert full_result.truncated is False

        # Artifact contains the full normalized content (same as non-truncated result)
        with open(result.content_artifact_path, "r", encoding="utf-8") as f:
            artifact_content = f.read()
        assert artifact_content == full_result.content
        assert len(artifact_content) > len(result.content)

        # Verify it's in a system temp directory
        temp_dir = tempfile.gettempdir()
        assert result.content_artifact_path.startswith(temp_dir)

        # Clean up temp file
        os.unlink(result.content_artifact_path)

    def test_no_artifact_when_not_truncated(self):
        """When content fits within max_chars, no artifact file is created."""
        short_text = "Short content that fits within the limit."
        result = process(
            body=short_text.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com/short.txt",
            output_format="text",
            max_chars=100_000,
        )

        assert result.truncated is False
        assert result.content_artifact_path is None

    def test_artifact_in_temp_directory(self):
        """Content artifact is written to the system temp directory (ephemeral)."""
        text_line = "Line of text for temp directory test. "
        body = (text_line * 200).encode("utf-8")
        result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/temp-test.txt",
            output_format="text",
            max_chars=1000,
        )

        assert result.truncated is True
        assert result.content_artifact_path is not None

        # File is in the system temp directory
        temp_dir = tempfile.gettempdir()
        assert result.content_artifact_path.startswith(temp_dir)

        # File has the expected prefix
        file_name = os.path.basename(result.content_artifact_path)
        assert file_name.startswith("pi-web-fetch-")

        # File is ephemeral (can be deleted after use)
        assert os.path.exists(result.content_artifact_path)
        os.unlink(result.content_artifact_path)
        assert not os.path.exists(result.content_artifact_path)


# ===========================================================================
# sourceTruncated flag
# ===========================================================================

class TestSourceTruncated:
    """sourceTruncated is reported independently of truncated."""

    def test_neither_truncated(self):
        """Both flags are False when content fits and no source truncation."""
        result = process(
            body=b"short content",
            content_type="text/plain",
            url="https://example.com/",
            output_format="text",
            max_chars=100_000,
            source_truncated=False,
        )
        assert result.truncated is False
        assert result.source_truncated is False

    def test_only_preview_truncated(self):
        """truncated=True, source_truncated=False when preview is cut but source is complete."""
        text_line = "Line of text for the source truncated test. "
        body = (text_line * 500).encode("utf-8")  # ~20k chars
        result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/",
            output_format="text",
            max_chars=5000,
            source_truncated=False,
        )
        assert result.truncated is True
        assert result.source_truncated is False

    def test_only_source_truncated(self):
        """truncated=False, source_truncated=True when source is truncated but preview fits."""
        short_text = "Short content that fits within the limit."
        result = process(
            body=short_text.encode("utf-8"),
            content_type="text/plain",
            url="https://example.com/",
            output_format="text",
            max_chars=100_000,
            source_truncated=True,
        )
        assert result.truncated is False
        assert result.source_truncated is True

    def test_both_truncated(self):
        """Both flags are True when source is truncated AND preview is cut."""
        text_line = "Line of text for the source truncated test. "
        body = (text_line * 500).encode("utf-8")  # ~20k chars
        result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/",
            output_format="text",
            max_chars=5000,
            source_truncated=True,
        )
        assert result.truncated is True
        assert result.source_truncated is True
        os.unlink(result.content_artifact_path)


# ===========================================================================
# Content artifact format
# ===========================================================================

class TestContentArtifactFormat:
    """Content artifacts use the same format as the preview."""

    def test_markdown_format(self):
        """Artifact uses .md extension when output is markdown."""
        text_line = "Line of text for format test. "
        body = (text_line * 200).encode("utf-8")
        result = process(
            body=body,
            content_type="text/markdown",
            url="https://example.com/test.md",
            output_format="markdown",
            max_chars=1000,
        )
        assert result.truncated is True
        assert result.content_artifact_path is not None
        assert result.content_artifact_path.endswith(".md")
        os.unlink(result.content_artifact_path)

    def test_text_format(self):
        """Artifact uses .txt extension when output is text."""
        text_line = "Line of text for format test. "
        body = (text_line * 200).encode("utf-8")
        result = process(
            body=body,
            content_type="text/plain",
            url="https://example.com/test.txt",
            output_format="text",
            max_chars=1000,
        )
        assert result.truncated is True
        assert result.content_artifact_path is not None
        assert result.content_artifact_path.endswith(".txt")
        os.unlink(result.content_artifact_path)


# ===========================================================================
# Raw mode
# ===========================================================================

class TestRawMode:
    """Raw mode bypasses extraction and returns decoded source as-is."""

    def test_raw_html_bypasses_extraction(self):
        """When raw=True, HTML content is returned without readability extraction."""
        raw_html = b"<html><body><h1>Hello</h1><p>World</p></body></html>"
        result = process(
            body=raw_html,
            content_type="text/html",
            url="https://example.com",
            output_format="markdown",
            max_chars=100_000,
            raw=True,
        )
        assert isinstance(result, PipelineResult)
        # Content should be the raw HTML, not markdown-extracted text
        assert "<h1>Hello</h1>" in result.content
        assert "<html>" in result.content
        assert result.title is None  # No title extraction in raw mode
        assert result.truncated is False
        assert result.warnings == []

    def test_raw_ignores_format_parameter(self):
        """When raw=True, the output_format parameter is ignored."""
        raw_html = b"<html><body><h1>Same</h1></body></html>"
        markdown_result = process(
            body=raw_html,
            content_type="text/html",
            url="https://example.com",
            output_format="markdown",
            max_chars=100_000,
            raw=True,
        )
        text_result = process(
            body=raw_html,
            content_type="text/html",
            url="https://example.com",
            output_format="text",
            max_chars=100_000,
            raw=True,
        )
        assert markdown_result.content == text_result.content
        assert "<h1>Same</h1>" in markdown_result.content
        assert markdown_result.title is None
        assert text_result.title is None

    def test_raw_output_truncated_with_artifact(self):
        """Raw output goes through the same truncation and artifact pipeline as readable."""
        # Generate raw HTML long enough to exceed max_chars
        long_html_line = "<p>" + "x" * 100 + "</p>"
        body = ("<html><body>" + long_html_line * 30 + "</body></html>").encode("utf-8")
        result = process(
            body=body,
            content_type="text/html",
            url="https://example.com",
            output_format="markdown",
            max_chars=500,
            raw=True,
        )
        assert result.truncated is True
        assert result.content_artifact_path is not None
        assert os.path.exists(result.content_artifact_path)
        # The artifact should contain the full raw HTML
        with open(result.content_artifact_path, "r") as f:
            artifact_content = f.read()
        assert "<html>" in artifact_content
        assert len(artifact_content) > len(result.content)
        # Clean up
        os.unlink(result.content_artifact_path)
