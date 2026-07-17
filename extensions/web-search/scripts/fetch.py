#!/usr/bin/env python3
"""Pi web-fetch helper: fetch HTTP(S) URLs, extract readable content, return JSON."""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import mimetypes
import socket
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

import httpx
from bs4 import BeautifulSoup, Tag

from github import classify, fetch_github_blob_content, fetch_github_tree, render_tree, GitHubResource as _GitHubResource
from representation import (
    OutputFormat,
    ContentCategory,
    find_main_container,
    extract_title,
    strip_boilerplate,
    strip_anchor_links,
    decode_body,
    _normalize_whitespace,
    _extract_html,
    _extract_text_like,
    _truncate,
    process as _pipeline_process,
    categorize_content,
)

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ExtractedDocument = Dict[str, Any]
"""
Stable shape expected by the TypeScript side:
{
  "url": str,
  "finalUrl": str,
  "statusCode": int,
  "contentType": str | None,
  "title": str | None,
  "format": str,
  "content": str,
  "truncated": bool,
  "contentLength": int,
  "fetchedBytes": int,
  "warnings": List[str],
}
On error:
{
  "error": str,
  "url": str,
  "details": dict | None,
}
"""

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Representation pipeline types are imported from representation module.
# Only fetch-specific constants remain here.

# Binary types accepted only in --download mode.
# Keep this list small and intentional: images + PDFs. Add more only with
# matching test coverage in test_fetch.py.
SUPPORTED_DOWNLOAD_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "image/bmp",
    "image/tiff",
    "image/x-icon",
    "image/vnd.microsoft.icon",
    "application/pdf",
}

# Map media types → canonical file extensions used for the temp file.
# Falls back to mimetypes.guess_extension or ".bin" if not listed.
_DOWNLOAD_EXTENSIONS: Dict[str, str] = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
    "application/pdf": ".pdf",
}

PRIVATE_HOST_CACHE: Dict[str, bool] = {}

USER_AGENT = (
    "pi-web-fetch/0.1 "
    "(+https://github.com/earendil-works/pi-coding-agent; "
    "like curl/8.0)"
)

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class FetchError(Exception):
    """Controlled error that produces a structured JSON response."""

    def __init__(self, message: str, details: Optional[Dict[str, Any]] = None) -> None:
        self.message = message
        self.details = details or {}
        super().__init__(message)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch a URL and extract readable content.",
    )
    parser.add_argument("--url", "-u", required=True, help="HTTP(S) URL to fetch")
    parser.add_argument(
        "--max-chars",
        "-m",
        type=int,
        default=30_000,
        help="Max characters of extracted content (default 30000, max 100000)",
    )
    parser.add_argument(
        "--format",
        "-f",
        choices=["markdown", "text"],
        default="markdown",
        help="Output format (default markdown)",
    )
    parser.add_argument(
        "--timeout",
        "-t",
        type=int,
        default=20,
        help="Request timeout in seconds (default 20)",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=5_242_880,
        help="Max fetch bytes (default 5 MiB)",
    )
    parser.add_argument(
        "--raw",
        action="store_true",
        help=(
            "Return the raw decoded source instead of extracted text. "
            "Ignores --format. Mutually exclusive with --download."
        ),
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help=(
            "Download the response body to a local temp file and return its path "
            "instead of extracting readable text. Accepts image/* and application/pdf. "
            "Ignores --max-chars and --format."
        ),
    )
    return parser.parse_args(argv)


# ---------------------------------------------------------------------------
# URL validation + SSRF protection
# ---------------------------------------------------------------------------


def is_private_or_local_address(hostname: str) -> Tuple[bool, str]:
    """Check if hostname resolves to a private/local IP."""
    # Check cache first
    cached = PRIVATE_HOST_CACHE.get(hostname)
    if cached is not None:
        return cached, ""

    try:
        addrinfos = socket.getaddrinfo(hostname, 80, type=socket.SOCK_STREAM)
    except OSError as exc:
        PRIVATE_HOST_CACHE[hostname] = True
        return True, f"DNS resolution failed: {exc}"

    for addr_info in addrinfos:
        addr = addr_info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue

        if ip.is_loopback:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to loopback address: {addr}"
        if ip.is_private:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to private address: {addr}"
        if ip.is_link_local:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to link-local address: {addr}"
        if ip.is_multicast:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to multicast address: {addr}"
        if ip.is_unspecified:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to unspecified address: {addr}"
        if ip.is_reserved:
            PRIVATE_HOST_CACHE[hostname] = True
            return True, f"Host resolves to reserved address: {addr}"

    PRIVATE_HOST_CACHE[hostname] = False
    return False, ""


def validate_url(url: str) -> httpx.URL:
    """Validate URL scheme/format/SSRF, returning parsed URL or raising FetchError."""
    try:
        parsed = httpx.URL(url)
    except Exception as exc:
        raise FetchError(
            "Invalid URL format",
            {"url": url, "detail": str(exc)},
        ) from exc

    if parsed.scheme not in ("http", "https"):
        raise FetchError(
            f"Unsupported URL scheme: '{parsed.scheme}'. Only http and https are allowed.",
            {"url": url, "scheme": parsed.scheme},
        )

    host = parsed.host
    if not host:
        raise FetchError("URL has no hostname", {"url": url})

    # Check for credentials in URL
    if parsed.username or parsed.password:
        raise FetchError(
            "URL contains embedded credentials (username:password). Refusing to fetch.",
            {"url": url},
        )

    # SSRF guard
    is_private, reason = is_private_or_local_address(host)
    if is_private:
        raise FetchError(
            f"Fetch refused: {reason}",
            {"url": url, "host": host},
        )

    return parsed


# ---------------------------------------------------------------------------
# HTTP fetching
# ---------------------------------------------------------------------------


def fetch_response(
    url: str,
    timeout: float,
    max_bytes: int,
    mode: Literal["text", "download"] = "text",
) -> Dict[str, Any]:
    """Fetch URL and return response metadata + body bytes.

    mode="text" (default): reject responses whose Content-Type is not
        HTML or text-like. Used by the text extraction path.
    mode="download": reject responses whose Content-Type is not in the
        binary download allowlist (image/*, application/pdf).
    """
    parsed = validate_url(url)
    url_str = str(parsed)

    with httpx.Client(
        follow_redirects=True,
        max_redirects=5,
        timeout=httpx.Timeout(timeout),
    ) as client:
        response = client.get(
            url_str,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html, application/xhtml+xml, text/plain, "
                "text/markdown, application/json, application/xml, text/xml;q=0.9, */*;q=0.1",
            },
        )

        final_url = str(response.url)
        # Re-validate final URL after redirects
        if final_url != url_str:
            validate_url(final_url)

        content_type = response.headers.get("content-type")

        if mode == "download":
            allowed = is_download_supported(content_type)
            unsupported_msg = (
                f"Content type '{content_type or 'unknown'}' is not supported in --download mode. "
                f"Allowed: {sorted(SUPPORTED_DOWNLOAD_TYPES)}"
            )
        else:
            category = categorize_content(content_type)
            allowed = category != "unsupported"
            unsupported_msg = f"Unsupported content type: {content_type or 'unknown'}"

        if not allowed:
            raise FetchError(
                unsupported_msg,
                {
                    "url": url_str,
                    "finalUrl": final_url,
                    "statusCode": response.status_code,
                    "contentType": content_type,
                },
            )

        # Stream body with size limit
        body_chunks: List[bytes] = []
        total_bytes = 0
        for chunk in response.iter_bytes(chunk_size=65536):
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                raise FetchError(
                    f"Response exceeds maximum fetch size ({max_bytes} bytes)",
                    {
                        "url": url_str,
                        "finalUrl": final_url,
                        "statusCode": response.status_code,
                        "contentType": content_type,
                        "maxBytes": max_bytes,
                    },
                )
            body_chunks.append(chunk)

        body = b"".join(body_chunks)

        return {
            "url": url_str,
            "finalUrl": final_url,
            "statusCode": response.status_code,
            "contentType": content_type,
            "body": body,
            "fetchedBytes": total_bytes,
        }


# ---------------------------------------------------------------------------
# Content categorization
# ---------------------------------------------------------------------------


# categorize_content is imported from representation module
def is_download_supported(content_type: Optional[str]) -> bool:
    """Return True if the content type is in the binary download allowlist."""
    if not content_type:
        return False
    media_type = content_type.split(";")[0].strip().lower()
    return media_type in SUPPORTED_DOWNLOAD_TYPES


def _is_binary_content(data: bytes) -> bool:
    """Check whether *data* looks like binary content.

    Uses two heuristics:
    1. If the bytes cannot be decoded as UTF-8, they are binary.
    2. If UTF-8 decoding succeeds but null bytes (``\x00``) are present,
       the content is treated as binary.

    Args:
        data: Raw bytes to inspect.

    Returns:
        ``True`` if the data appears to be binary.
    """
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    # Null bytes are a reliable binary indicator
    return "\x00" in text


def media_type_of(content_type: Optional[str]) -> Optional[str]:
    """Return the lowercased media type without parameters, or None."""
    if not content_type:
        return None
    return content_type.split(";")[0].strip().lower() or None


def extension_for(content_type: Optional[str], url: str) -> str:
    """Pick a sensible file extension for a downloaded binary.

    Order of preference:
      1. Explicit mapping in _DOWNLOAD_EXTENSIONS for the Content-Type.
      2. Extension already present in the URL path (lower-cased).
      3. mimetypes.guess_extension() on the media type.
      4. ".bin" fallback.
    """
    media_type = media_type_of(content_type)

    if media_type and media_type in _DOWNLOAD_EXTENSIONS:
        return _DOWNLOAD_EXTENSIONS[media_type]

    # Try the URL path before falling back.
    try:
        url_path = httpx.URL(url).path
    except Exception:
        url_path = ""

    url_ext = Path(url_path).suffix.lower()
    if url_ext and len(url_ext) <= 6 and url_ext.isascii():
        return url_ext

    if media_type:
        guessed = mimetypes.guess_extension(media_type)
        if guessed:
            return guessed

    return ".bin"


def is_supported_content_type(content_type: Optional[str]) -> bool:
    """Return True if the content type is in the supported set."""
    return categorize_content(content_type) != "unsupported"


# ---------------------------------------------------------------------------
# Body decoding
# ---------------------------------------------------------------------------


# Decode body is imported from representation module

# ---------------------------------------------------------------------------
# Content extraction
# ---------------------------------------------------------------------------
# Tags to strip from extracted semantic containers.
# Note: header/footer are NOT stripped here because the semantic container
# (article/main) IS the content boundary — page-level header/footer are
# already excluded. Stripping them inside the container risks losing
# article-level headings and metadata.
# Extraction constants live in representation.py.


# find_main_container is imported from representation module


# extract_title is imported from representation module
# strip_boilerplate is imported from representation module
# strip_anchor_links is imported from representation module
# _extract_via_readability is in representation module
def extract_html(
    html_text: str,
    url: str,
    output_format: OutputFormat,
) -> ExtractedDocument:
    """Extract readable content from HTML.

    Delegates to the representation module.
    """
    title, content, warnings = _extract_html(html_text, url, output_format)
    return {"title": title, "content": content, "warnings": warnings}
def extract_text_like(
    text: str,
    content_type: Optional[str],
    output_format: OutputFormat,
) -> ExtractedDocument:
    """Extract content from plain text, markdown, JSON, or XML responses.

    Delegates to the representation module.
    """
    title, content, warnings = _extract_text_like(text, content_type, output_format)
    return {"title": title, "content": content, "warnings": warnings}
# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------


def normalize_whitespace(text: str) -> str:
    """Collapse excessive blank lines and trim trailing whitespace.

    Delegates to the representation module.
    """
    return _normalize_whitespace(text)
def truncate_content(text: str, max_chars: int) -> Tuple[str, bool]:
    """Truncate text to max_chars, with message if truncated.

    Delegates to the representation module.
    """
    return _truncate(text, max_chars)
# ---------------------------------------------------------------------------
# JSON response builders
# ---------------------------------------------------------------------------


def download_json(
    url: str,
    final_url: str,
    status_code: int,
    content_type: Optional[str],
    path: str,
    file_name: str,
    byte_size: int,
    sha1: str,
    warnings: List[str],
) -> Dict[str, Any]:
    """Build success JSON response for --download mode."""
    return {
        "url": url,
        "finalUrl": final_url,
        "statusCode": status_code,
        "contentType": content_type,
        "path": path,
        "fileName": file_name,
        "byteSize": byte_size,
        "sha1": sha1,
        "warnings": warnings,
    }


def success_json(
    url: str,
    final_url: str,
    status_code: int,
    content_type: Optional[str],
    title: Optional[str],
    output_format: OutputFormat,
    content: str,
    truncated: bool,
    fetched_bytes: int,
    warnings: List[str],
    content_artifact_path: Optional[str] = None,
    source_truncated: bool = False,
) -> Dict[str, Any]:
    """Build success JSON response."""
    result: Dict[str, Any] = {
        "url": url,
        "finalUrl": final_url,
        "statusCode": status_code,
        "contentType": content_type,
        "title": title,
        "format": output_format,
        "content": content,
        "truncated": truncated,
        "contentLength": len(content),
        "fetchedBytes": fetched_bytes,
        "warnings": warnings,
        "sourceTruncated": source_truncated,
    }
    if content_artifact_path is not None:
        result["contentArtifactPath"] = content_artifact_path
    return result


def error_json(
    message: str,
    url: str,
    details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build error JSON response."""
    result: Dict[str, Any] = {
        "error": message,
        "url": url,
    }
    if details:
        result["details"] = details
    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------


def run_download(
    url: str,
    timeout: float,
    max_bytes: int,
) -> Dict[str, Any]:
    """Download a binary response to a temp file and return its metadata.

    Raises FetchError on validation/HTTP/MIME/size failures using the same
    error envelope as the text path; never returns a partial file.
    """
    fetch_result = fetch_response(
        url=url,
        timeout=timeout,
        max_bytes=max_bytes,
        mode="download",
    )

    final_url = fetch_result["finalUrl"]
    status_code = fetch_result["statusCode"]
    content_type = fetch_result.get("contentType")
    body: bytes = fetch_result["body"]
    fetched_bytes = fetch_result["fetchedBytes"]

    if not body:
        raise FetchError(
            "Response body was empty; nothing to download.",
            {
                "url": url,
                "finalUrl": final_url,
                "statusCode": status_code,
                "contentType": content_type,
            },
        )

    # SHA-1 is used purely as a content address for the temp file name;
    # not for security.
    sha1 = hashlib.sha1(body).hexdigest()  # noqa: S324
    extension = extension_for(content_type, final_url)
    file_name = f"web-fetch-{sha1[:12]}{extension}"
    # Use the process-shared temp dir; cleanup is delegated to the OS.
    target_dir = tempfile.gettempdir()
    target_path = str(Path(target_dir) / file_name)

    # Refuse to clobber an unrelated file at the same path.
    target = Path(target_path)
    if target.exists() and target.stat().st_size != len(body):
        raise FetchError(
            f"Refusing to overwrite existing file at {target_path} with different content.",
            {"url": url, "path": target_path},
        )

    target.write_bytes(body)

    warnings: List[str] = []
    if status_code and status_code >= 400:
        warnings.append(f"HTTP {status_code} — saved body anyway, but the response is an error page.")

    return download_json(
        url=url,
        final_url=final_url,
        status_code=status_code,
        content_type=content_type,
        path=target_path,
        file_name=file_name,
        byte_size=len(body),
        sha1=sha1,
        warnings=warnings,
    )


def main(argv: Optional[List[str]] = None) -> int:
    """Validate, fetch, extract, print JSON. Return 0 on success, 1 on error."""
    args = parse_args(argv)

    try:
        if args.raw and args.download:
            raise FetchError(
                "raw and download are mutually exclusive. "
                "Use either --raw (return decoded source) or --download (save to file), not both.",
                {"url": args.url},
            )

        # Check for recognised GitHub resource — never fall back to HTML extraction
        classified = classify(args.url)
        if isinstance(classified, _GitHubResource):
            if classified.type in ("repository_root", "tree"):
                # Tree representation path (ticket 0053)
                gh_result = fetch_github_tree(args.url)
                if "error" in gh_result:
                    print(json.dumps(gh_result, ensure_ascii=False))
                    return 1
                tree_data = gh_result.get("data", {})
                source_truncated = gh_result.get("sourceTruncated", False)
                tree_warnings = gh_result.get("warnings", [])
                final_url = gh_result.get("finalUrl", args.url)
                status_code = gh_result.get("statusCode", 200)

                if args.raw:
                    # Raw mode: return canonical GitHub API JSON
                    body_str = tree_data.get("canonicalJson", "{}")
                    effective_format = "raw"
                else:
                    # Readable mode: render tree to markdown/text
                    effective_format = args.format or "markdown"
                    body_str = render_tree(tree_data, effective_format)

                content_type = "application/json" if args.raw else "text/plain; charset=utf-8"
                fetched_bytes = len(body_str.encode("utf-8"))
                pipeline_result = _pipeline_process(
                    body=body_str.encode("utf-8"),
                    content_type=content_type,
                    url=args.url,
                    output_format=effective_format if not args.raw else "text",
                    max_chars=args.max_chars,
                    raw=args.raw,
                    source_truncated=source_truncated,
                )
                # Merge tree warnings with pipeline warnings
                all_warnings = tree_warnings + (pipeline_result.warnings or [])
                result = success_json(
                    url=args.url,
                    final_url=final_url,
                    status_code=status_code,
                    content_type=content_type,
                    title=pipeline_result.title,
                    output_format=effective_format,
                    content=pipeline_result.content,
                    truncated=pipeline_result.truncated,
                    fetched_bytes=fetched_bytes,
                    warnings=all_warnings,
                    content_artifact_path=pipeline_result.content_artifact_path,
                    source_truncated=pipeline_result.source_truncated or source_truncated,
                )
                print(json.dumps(result, ensure_ascii=False))
                return 0
            else:
                # Blob resource path (Contents API) — fetch and decode file content
                gh_result = fetch_github_blob_content(args.url)
                if "error" in gh_result:
                    print(json.dumps(gh_result, ensure_ascii=False))
                    return 1

                decoded_bytes = gh_result["data"]
                content_type = gh_result["contentType"]
                name = gh_result["name"]
                final_url = gh_result.get("finalUrl", args.url)
                status_code = gh_result.get("statusCode", 200)

                if args.download:
                    # Download mode: write decoded bytes to temp file
                    if not is_download_supported(content_type):
                        raise FetchError(
                            f"Download is not supported for content type '{content_type}'. "
                            f"Supported types: {', '.join(sorted(SUPPORTED_DOWNLOAD_TYPES))}.",
                            {"url": args.url, "contentType": content_type},
                        )

                    if len(decoded_bytes) > args.max_bytes:
                        raise FetchError(
                            f"Content exceeds maximum download size of {args.max_bytes} bytes "
                            f"(actual: {len(decoded_bytes)} bytes).",
                            {"url": args.url, "byteSize": len(decoded_bytes), "maxBytes": args.max_bytes},
                        )

                    # SHA-1 is used purely as a content address for the temp file name
                    sha1 = hashlib.sha1(decoded_bytes).hexdigest()  # noqa: S324
                    extension = extension_for(content_type, name)
                    file_name = f"web-fetch-{sha1[:12]}{extension}"
                    target_dir = tempfile.gettempdir()
                    target_path = str(Path(target_dir) / file_name)

                    target = Path(target_path)
                    if target.exists() and target.stat().st_size != len(decoded_bytes):
                        # Collision: same-name but different size → add hash suffix
                        target_path = str(
                            Path(target_dir) / f"web-fetch-{sha1[:12]}-{sha1[:8]}{extension}"
                        )
                        target = Path(target_path)

                    target.write_bytes(decoded_bytes)

                    result = download_json(
                        url=args.url,
                        final_url=final_url,
                        status_code=status_code,
                        content_type=content_type,
                        path=target_path,
                        file_name=file_name,
                        byte_size=len(decoded_bytes),
                        sha1=sha1,
                        warnings=[],
                    )
                else:
                    # Text / raw mode: check for binary content
                    if _is_binary_content(decoded_bytes):
                        print(json.dumps(error_json(
                            "Detected binary blob. Use `download: true` to obtain the file via the GitHub API.",
                            args.url,
                            {"url": args.url, "contentType": content_type, "name": name},
                        )))
                        return 1

                    # Decode text and run through representation pipeline
                    text = decoded_bytes.decode("utf-8")
                    fetched_bytes = len(decoded_bytes)
                    effective_format = "raw" if args.raw else (args.format or "markdown")
                    pipeline_result = _pipeline_process(
                        body=decoded_bytes,
                        content_type=content_type,
                        url=args.url,
                        output_format=effective_format if not args.raw else "text",
                        max_chars=args.max_chars,
                        raw=args.raw,
                    )
                    result = success_json(
                        url=args.url,
                        final_url=final_url,
                        status_code=status_code,
                        content_type=content_type,
                        title=pipeline_result.title,
                        output_format=effective_format,
                        content=pipeline_result.content,
                        truncated=pipeline_result.truncated,
                        fetched_bytes=fetched_bytes,
                        warnings=pipeline_result.warnings,
                        content_artifact_path=pipeline_result.content_artifact_path,
                        source_truncated=pipeline_result.source_truncated,
                    )

                print(json.dumps(result, ensure_ascii=False))
                return 0

        if args.download:
            result = run_download(
                url=args.url,
                timeout=float(args.timeout),
                max_bytes=args.max_bytes,
            )
            print(json.dumps(result, ensure_ascii=False))
            return 0

        # Fetch (generic, non-GitHub URL)
        fetch_result = fetch_response(
            url=args.url,
            timeout=float(args.timeout),
            max_bytes=args.max_bytes,
        )

        url = fetch_result["url"]
        final_url = fetch_result["finalUrl"]
        status_code = fetch_result["statusCode"]
        content_type = fetch_result.get("contentType")
        body = fetch_result["body"]
        fetched_bytes = fetch_result["fetchedBytes"]

        # Determine effective format: raw mode reports "raw" irrespective of --format
        effective_format = "raw" if args.raw else (args.format or "markdown")

        # Run the representation pipeline (decode → extract → truncate)
        pipeline_result = _pipeline_process(
            body=body,
            content_type=content_type,
            url=url,
            output_format=effective_format if not args.raw else "text",
            max_chars=args.max_chars,
            raw=args.raw,
        )

        # Build success JSON
        result = success_json(
            url=url,
            final_url=final_url,
            status_code=status_code,
            content_type=content_type,
            title=pipeline_result.title,
            output_format=effective_format,
            content=pipeline_result.content,
            truncated=pipeline_result.truncated,
            fetched_bytes=fetched_bytes,
            warnings=pipeline_result.warnings,
            content_artifact_path=pipeline_result.content_artifact_path,
            source_truncated=pipeline_result.source_truncated,
        )

        print(json.dumps(result, ensure_ascii=False))
        return 0

    except FetchError as exc:
        print(json.dumps(error_json(exc.message, args.url, exc.details), ensure_ascii=False))
        return 1

    except Exception as exc:
        print(
            json.dumps(
                error_json(f"Internal error: {exc}", args.url),
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
