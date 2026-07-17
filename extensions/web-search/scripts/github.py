"""GitHub URL classification and ref resolution.

This module classifies ``github.com`` URLs into resource families
(repository-root, tree, blob, or non-specialized) and resolves
the identified ref and path components.

Functions:
    classify: URL string in → GitHubResource | NonSpecialized
    resolve_ref: Resolve an ambiguous ref string against the GitHub API.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
from dataclasses import dataclass
from typing import List, Literal, Optional, Union
from urllib.parse import quote, urlparse, unquote

import httpx

ResourceType = Literal["repository_root", "tree", "blob"]


@dataclass
class GitHubResource:
    """A recognized GitHub resource.

    Attributes:
        type: The resource family (repository_root, tree, or blob).
        owner: Repository owner (user or organisation).
        repo: Repository name.
        ref: Branch, tag, or commit SHA (None for repository-root URLs).
        path: Path within the repository (None for repo-root).
    """

    type: ResourceType
    owner: str
    repo: str
    ref: Optional[str] = None
    path: Optional[str] = None


@dataclass
class NonSpecialized:
    """A URL that is not a recognized GitHub resource.

    Attributes:
        url: The original URL.
        reason: Human-readable explanation.
    """

    url: str
    reason: str


def classify(url: str) -> Union[GitHubResource, NonSpecialized]:
    """Classify a ``github.com`` URL into a resource family.

    Args:
        url: The URL to classify.

    Returns:
        A ``GitHubResource`` if the URL is a recognised repository-root,
        tree, or blob URL.  A ``NonSpecialized`` result otherwise.
    """
    parsed = urlparse(url)

    # Must be github.com or www.github.com
    host = parsed.hostname
    if host is None:
        return NonSpecialized(url=url, reason="no hostname")
    if host not in ("github.com", "www.github.com"):
        return NonSpecialized(url=url, reason=f"unrecognised host: {host}")

    raw_path = parsed.path.rstrip("/")

    # Minimum path: /<owner>/<repo>
    raw_segments = [s for s in raw_path.split("/") if s]
    if len(raw_segments) < 2:
        return NonSpecialized(url=url, reason="path too short for owner/repo")

    owner = unquote(raw_segments[0])
    repo = unquote(raw_segments[1]).removesuffix(".git")

    if len(raw_segments) == 2:
        return GitHubResource(type="repository_root", owner=owner, repo=repo)

    # 3+ segments: check the third segment
    resource_indicator = raw_segments[2]

    if resource_indicator in ("tree", "blob") and len(raw_segments) >= 3:
        # Heuristic: first segment after tree/blob is the ref,
        # remaining segments are the path.
        ref = unquote(raw_segments[3]) if len(raw_segments) > 3 else None
        path_segments = [unquote(s) for s in raw_segments[4:]]
        path = "/".join(path_segments) if path_segments else None
        resource_type: ResourceType = "tree" if resource_indicator == "tree" else "blob"
        return GitHubResource(
            type=resource_type,
            owner=owner,
            repo=repo,
            ref=ref,
            path=path,
        )

    return NonSpecialized(url=url, reason="unrecognised URL pattern")


# ---------------------------------------------------------------------------
# Ref resolution
# ---------------------------------------------------------------------------

GITHUB_API = "https://api.github.com"

# Regex for a full 40-character hex commit SHA
_SHA_RE = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


@dataclass
class ResolvedRef:
    """Result of resolving an ambiguous GitHub ref against the API.

    Attributes:
        ref: The resolved branch, tag, or commit SHA.
        path_remainder: The portion of the original ref string that is not
            part of the ref — i.e., the resource path within the repository.
            ``None`` when the entire string was consumed by the ref.
    """

    ref: str
    path_remainder: Optional[str] = None


def _prefixes(ref: str) -> List[str]:
    """Generate all prefixes of *ref* from longest to shortest."""
    parts = ref.split("/")
    return ["/".join(parts[:i]) for i in range(len(parts), 0, -1)]


def _path_remainder(ref: str, full_ref: str) -> Optional[str]:
    """Return the portion of *full_ref* after the resolved *ref* prefix."""
    if ref == full_ref:
        return None
    remainder = full_ref[len(ref) + 1:]  # +1 for the separating "/"
    return remainder if remainder else None


def _resolve_token(token: Optional[str]) -> Optional[str]:
    """Resolve the effective GITHUB_TOKEN from explicit arg or environment."""
    return token if token is not None else os.environ.get("GITHUB_TOKEN")


def _headers(token: Optional[str]) -> dict:
    """Build request headers, optionally adding GITHUB_TOKEN auth."""
    effective = _resolve_token(token)
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "pi-agent/1.0",
    }
    if effective:
        headers["Authorization"] = f"Bearer {effective}"
    return headers


def resolve_ref(
    owner: str,
    repo: str,
    full_ref: str,
    *,
    token: Optional[str] = None,
) -> ResolvedRef:
    """Resolve an ambiguous GitHub ref string against the GitHub API.

    If the entire *full_ref* starts with a valid 40-character commit SHA,
    the SHA is used immediately without API calls.  Otherwise, each prefix
    of *full_ref* (longest first) is tried as a branch name, then as a tag
    name.  The longest valid ref wins.

    Args:
        owner: Repository owner.
        repo: Repository name.
        full_ref: The full ref string to resolve (may include path segments).
        token: Optional ``GITHUB_TOKEN`` for authenticated requests.

    Returns:
        A ``ResolvedRef`` with the resolved ref and any path remainder.

    Raises:
        ValueError: When *full_ref* cannot be resolved.
    """
    token = _resolve_token(token)

    # --- Short-circuit: commit SHA ---
    sha = full_ref[:40]
    if _SHA_RE.match(sha):
        return ResolvedRef(
            ref=sha,
            path_remainder=_path_remainder(sha, full_ref),
        )

    candidates = _prefixes(full_ref)

    # --- Try branches ---
    for prefix in candidates:
        url = f"{GITHUB_API}/repos/{owner}/{repo}/branches/{quote(prefix, safe='')}"
        resp = httpx.get(url, headers=_headers(token))
        if resp.status_code == 200:
            return ResolvedRef(
                ref=prefix,
                path_remainder=_path_remainder(prefix, full_ref),
            )

    # --- Try tags (via git ref API) ---
    for prefix in candidates:
        url = f"{GITHUB_API}/repos/{owner}/{repo}/git/ref/tags/{quote(prefix, safe='')}"
        resp = httpx.get(url, headers=_headers(token))
        if resp.status_code == 200:
            return ResolvedRef(
                ref=prefix,
                path_remainder=_path_remainder(prefix, full_ref),
            )

    # --- Try commit SHA ---
    sha = full_ref[:40]
    if _SHA_RE.match(sha):
        return ResolvedRef(
            ref=sha,
            path_remainder=_path_remainder(sha, full_ref),
        )

    raise ValueError(
        f"cannot resolve ref '{full_ref}' for {owner}/{repo}"
    )


# ---------------------------------------------------------------------------
# GitHub resource fetch (structured error handling)
# ---------------------------------------------------------------------------


def _build_api_url(resource: GitHubResource) -> str:
    """Build the GitHub API URL for a recognised resource."""
    if resource.type == "repository_root":
        return f"{GITHUB_API}/repos/{resource.owner}/{resource.repo}"
    # tree and blob both use the contents API; differences are handled
    # by the caller based on the response shape.
    path = resource.path or ""
    url = f"{GITHUB_API}/repos/{resource.owner}/{resource.repo}/contents/{quote(path, safe='')}"
    if resource.ref:
        url += f"?ref={quote(resource.ref, safe='')}"
    return url


def _http_error_details(response: httpx.Response, authenticated: bool) -> dict:
    """Build structured error details from an HTTP error response.

    Extracts rate-limit metadata from headers when present.
    """
    details: dict = {
        "statusCode": response.status_code,
        "authenticated": authenticated,
    }

    # Rate-limit headers (present on 429 and sometimes on 403)
    remaining = response.headers.get("x-ratelimit-remaining")
    if remaining is not None:
        details["remaining"] = int(remaining)
    reset_epoch = response.headers.get("x-ratelimit-reset")
    if reset_epoch is not None:
        import datetime
        details["resetAt"] = datetime.datetime.fromtimestamp(
            int(reset_epoch), tz=datetime.UTC
        ).isoformat()

    return details


def fetch_github_resource(url: str, *, token: Optional[str] = None) -> dict:
    """Fetch a recognised GitHub resource through the GitHub API.

    Classifies the URL and, if it is a recognised repository-root, tree,
    or blob URL, makes the appropriate GitHub API call.  On success the
    API response JSON is returned wrapped in a metadata dict.  On failure
    a structured error dict is returned — **no** generic HTML extraction
    fallback occurs.

    Args:
        url: The GitHub URL to fetch.
        token: Optional ``GITHUB_TOKEN`` for authenticated requests.

    Returns:
        A dict representing the result.  Success shape:

        .. code-block:: python

            {
                "url": str,
                "finalUrl": str,
                "statusCode": int,
                "contentType": "application/json",
                "data": dict | list,  # parsed API response
            }

        Error shape:

        .. code-block:: python

            {
                "error": str,
                "url": str,
                "details": dict,
            }
    """
    token = _resolve_token(token)
    authenticated = token is not None

    # 1. Classify URL
    classified = classify(url)
    if isinstance(classified, NonSpecialized):
        return {
            "error": f"Not a recognised GitHub resource: {classified.reason}",
            "url": url,
            "details": {},
        }

    # 2. Build API URL
    api_url = _build_api_url(classified)

    # 3. Make API call — reuse shared header builder
    try:
        response = httpx.get(api_url, headers=_headers(token), follow_redirects=False, timeout=20.0)
    except Exception as exc:
        return {
            "error": f"GitHub API request failed: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    final_url = str(response.url)

    # 4. Handle error responses
    if response.status_code >= 400:
        details = _http_error_details(response, authenticated)
        return {
            "error": f"GitHub API returned {response.status_code}: {response.reason_phrase}",
            "url": url,
            "details": details,
        }

    # 5. Check for unexpected media type (GitHub API always returns JSON)
    response_content_type = response.headers.get("content-type", "")
    if response_content_type and "json" not in response_content_type.lower():
        # GitHub's API always returns JSON (application/json or vendor-scoped
        # variants like application/vnd.github.v3+json). Anything else (HTML,
        # plain text, binary) is unexpected.
        return {
            "error": f"GitHub API returned unexpected media type: {response_content_type}",
            "url": url,
            "details": {
                "statusCode": response.status_code,
                "contentType": response_content_type,
                "authenticated": authenticated,
            },
        }

    # 6. Validate JSON body
    try:
        data = response.json()
    except Exception:
        return {
            "error": "GitHub API returned malformed JSON",
            "url": url,
            "details": {
                "statusCode": response.status_code,
                "contentType": response_content_type,
                "authenticated": authenticated,
            },
        }

    # 6. Success
    content_type = response.headers.get("content-type", "application/json")
    return {
        "url": url,
        "finalUrl": final_url,
        "statusCode": response.status_code,
        "contentType": content_type,
        "data": data,
    }


# ---------------------------------------------------------------------------
# GitHub blob content fetch (Contents API, base64 decode)
# ---------------------------------------------------------------------------

def fetch_github_blob_content(
    url: str,
    *,
    token: Optional[str] = None,
) -> dict:
    """Fetch a blob's file content via the GitHub Contents API.

    Decodes the base64-encoded content from the API response and returns
    it as raw bytes with associated metadata.  Content type is inferred
    from the file name via ``mimetypes.guess_type``.

    Args:
        url: The GitHub blob URL to fetch.
        token: Optional ``GITHUB_TOKEN`` for authenticated requests.

    Returns:
        Success shape::

            {
                "url": str,
                "finalUrl": str,
                "statusCode": int,
                "contentType": str,    # MIME type guessed from file name
                "name": str,            # file name from API
                "size": int,            # decoded size from API
                "data": bytes,          # decoded file bytes
            }

        Error shape: same as ``fetch_github_resource``.
    """

    token = _resolve_token(token)
    authenticated = token is not None

    # 1. Classify URL — must be a blob
    classified = classify(url)
    if isinstance(classified, NonSpecialized):
        return {
            "error": f"Not a recognised GitHub resource: {classified.reason}",
            "url": url,
            "details": {},
        }
    if classified.type != "blob":
        return {
            "error": f"Unsupported resource type for blob content fetch: {classified.type}",
            "url": url,
            "details": {},
        }

    # 2. Build API URL (Contents API endpoint)
    api_url = _build_api_url(classified)

    # 3. Make API call
    try:
        response = httpx.get(
            api_url,
            headers=_headers(token),
            follow_redirects=False,
            timeout=20.0,
        )
    except Exception as exc:
        return {
            "error": f"GitHub API request failed: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    final_url = str(response.url)

    # 4. Handle error responses
    if response.status_code >= 400:
        details = _http_error_details(response, authenticated)
        return {
            "error": f"GitHub API returned {response.status_code}: {response.reason_phrase}",
            "url": url,
            "details": details,
        }

    # 5. Check response content type (GitHub API always returns JSON)
    response_content_type = response.headers.get("content-type", "")
    if response_content_type and "json" not in response_content_type.lower():
        return {
            "error": f"Unexpected response content type from GitHub API: {response_content_type}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    # 6. Parse JSON
    try:
        data = response.json()
    except Exception as exc:
        return {
            "error": f"GitHub API returned malformed JSON: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    # 7. Validate expected shape
    if not isinstance(data, dict):
        return {
            "error": "GitHub API returned unexpected data shape for blob content",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    if "content" not in data or data.get("encoding") != "base64":
        return {
            "error": "GitHub API did not return base64-encoded content for blob URL",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    # 8. Decode base64 content
    content_b64 = data["content"]
    try:
        decoded_bytes = base64.b64decode(content_b64)
    except Exception as exc:
        return {
            "error": f"Failed to decode base64 content from GitHub API: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    # 9. Infer content type from file name
    name = data.get("name", "")
    guessed_type, _ = mimetypes.guess_type(name)
    content_type = guessed_type or "application/octet-stream"

    return {
        "url": url,
        "finalUrl": final_url,
        "statusCode": response.status_code,
        "contentType": content_type,
        "name": name,
        "size": data.get("size", len(decoded_bytes)),
        "data": decoded_bytes,
    }


# ---------------------------------------------------------------------------
# GitHub tree fetch (git/trees API, recursive, sorted, bounded)
# ---------------------------------------------------------------------------


def fetch_github_tree(
    url: str,
    *,
    token: Optional[str] = None,
) -> dict:
    """Fetch a repository tree via the GitHub Git Trees API.

    For repository-root URLs the default branch is resolved first.
    For tree URLs the identified ref and requested directory are used.
    Entries are sorted lexicographically before returning.

    Returns:
        Success::

            {
                "url": str,
                "finalUrl": str,
                "statusCode": 200,
                "contentType": "application/json",
                "data": {
                    "owner": str,
                    "repo": str,
                    "ref": str,
                    "path": str | None,
                    "defaultBranch": str,
                    "entries": [{"path": str, "type": str, "mode": str, "sha": str}, ...],
                    "canonicalJson": str,
                    "totalCount": int,
                    "displayedCount": int,
                    "upstreamTruncated": bool,
                },
                "warnings": [str, ...],
                "sourceTruncated": bool,
            }

        Error::

            {
                "error": str,
                "url": str,
                "details": dict,
            }
    """
    token = _resolve_token(token)
    authenticated = token is not None

    # 1. Classify URL
    classified = classify(url)
    if isinstance(classified, NonSpecialized):
        return {
            "error": f"Not a recognised GitHub resource: {classified.reason}",
            "url": url,
            "details": {},
        }
    if classified.type not in ("repository_root", "tree"):
        return {
            "error": f"Unsupported resource type for tree fetch: {classified.type}",
            "url": url,
            "details": {},
        }

    owner = classified.owner
    repo = classified.repo

    # 2. Fetch repo metadata for default_branch
    repo_api = f"{GITHUB_API}/repos/{owner}/{repo}"
    try:
        resp = httpx.get(repo_api, headers=_headers(token), follow_redirects=False, timeout=20.0)
    except Exception as exc:
        return {
            "error": f"GitHub API request failed: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    if resp.status_code >= 400:
        return {
            "error": f"GitHub API returned {resp.status_code}: {resp.reason_phrase}",
            "url": url,
            "details": _http_error_details(resp, authenticated),
        }

    try:
        repo_data = resp.json()
    except Exception:
        return {
            "error": "GitHub API returned malformed JSON for repo metadata",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    default_branch: str = repo_data.get("default_branch", "main")
    final_url = str(resp.url)

    # 3. Determine effective ref and path
    if classified.type == "repository_root":
        ref = default_branch
        effective_path: Optional[str] = None
    else:
        # Tree URL: classify already parsed the ref/path, but for
        # slash-containing refs we need resolve_ref.  The full ref
        # string is everything after /tree/ in the URL path.
        parsed = urlparse(url)
        path_parts = parsed.path.rstrip("/").split("/")
        # path_parts = ['', owner, repo, 'tree', ...]
        if len(path_parts) > 4:
            full_ref_str = "/".join(path_parts[4:])
            try:
                resolved = resolve_ref(owner, repo, full_ref_str, token=token)
                ref = resolved.ref
                # path_remainder plus any additional path from classify
                # path_remainder is None when the entire string after /tree/
                # is consumed by the ref — no subdirectory filtering needed.
                if resolved.path_remainder:
                    effective_path = resolved.path_remainder
                else:
                    effective_path = None
            except ValueError:
                # Fall back to classify's split
                ref = classified.ref or default_branch
                effective_path = classified.path
        else:
            ref = default_branch
            effective_path = None

    # 4. Get commit SHA from the ref (handles branches, tags, and commit SHAs)
    commit_url = f"{GITHUB_API}/repos/{owner}/{repo}/commits/{quote(ref, safe='')}"
    try:
        resp = httpx.get(commit_url, headers=_headers(token), follow_redirects=False, timeout=20.0)
    except Exception as exc:
        return {
            "error": f"GitHub API request failed: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    if resp.status_code >= 400:
        return {
            "error": f"GitHub API returned {resp.status_code}: {resp.reason_phrase}",
            "url": url,
            "details": _http_error_details(resp, authenticated),
        }

    try:
        commit_data = resp.json()
    except Exception:
        return {
            "error": "GitHub API returned malformed JSON for commit",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    commit_sha = commit_data.get("sha")
    if not commit_sha:
        return {
            "error": "GitHub commit data missing SHA",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    # 5. Fetch recursive git tree
    tree_url = f"{GITHUB_API}/repos/{owner}/{repo}/git/trees/{commit_sha}?recursive=1"
    try:
        resp = httpx.get(tree_url, headers=_headers(token), follow_redirects=False, timeout=20.0)
    except Exception as exc:
        return {
            "error": f"GitHub API request failed: {exc}",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    if resp.status_code >= 400:
        return {
            "error": f"GitHub API returned {resp.status_code}: {resp.reason_phrase}",
            "url": url,
            "details": _http_error_details(resp, authenticated),
        }

    try:
        tree_data = resp.json()
    except Exception:
        return {
            "error": "GitHub API returned malformed JSON for git tree",
            "url": url,
            "details": {"authenticated": authenticated},
        }

    upstream_truncated: bool = tree_data.get("truncated", False)
    raw_entries: list = tree_data.get("tree", [])

    # 6. Filter to requested subdirectory for tree URLs
    if effective_path:
        prefix = effective_path.rstrip("/") + "/"
        filtered = [e for e in raw_entries if e.get("path", "").startswith(prefix)]
    else:
        filtered = list(raw_entries)

    # 7. Sort lexicographically (deterministic ordering)
    filtered.sort(key=lambda e: e.get("path", ""))

    # 8. Bound at 2,000 entries (after sorting — deterministic truncation)
    ENTRY_BOUND = 2000
    bound_truncated = len(filtered) > ENTRY_BOUND
    if bound_truncated:
        filtered = filtered[:ENTRY_BOUND]

    # 9. Source truncation: upstream OR local bound
    source_truncated = upstream_truncated or bound_truncated

    # Build canonical JSON from original tree_data (before filtering/bounding)
    canonical = json.dumps(tree_data, ensure_ascii=False, sort_keys=True)

    # Capture warnings
    warnings: List[str] = []
    if upstream_truncated:
        warnings.append(
            "GitHub API returned a truncated tree. "
            "The displayed listing may be incomplete."
        )
    if bound_truncated:
        warnings.append(
            f"Repository tree exceeds {ENTRY_BOUND} entries. "
            f"Showing the first {ENTRY_BOUND} entries."
        )

    return {
        "url": url,
        "finalUrl": final_url,
        "statusCode": 200,
        "contentType": "application/json",
        "data": {
            "owner": owner,
            "repo": repo,
            "ref": ref,
            "path": effective_path,
            "defaultBranch": default_branch,
            "entries": filtered,
            "canonicalJson": canonical,
            "totalCount": len(raw_entries),
            "displayedCount": len(filtered),
            "upstreamTruncated": upstream_truncated,
        },
        "warnings": warnings,
        "sourceTruncated": source_truncated,
    }


# ---------------------------------------------------------------------------
# Tree rendering
# ---------------------------------------------------------------------------


RenderFormat = Literal["markdown", "text"]


def render_tree(tree_data: dict, output_format: RenderFormat) -> str:
    """Render tree *data* (from ``fetch_github_tree``) as readable content.

    Args:
        tree_data: The ``data`` dict from ``fetch_github_tree``.
        output_format: ``"markdown"`` or ``"text"``.

    Returns:
        A formatted string listing repository metadata and sorted descendant
        paths.
    """
    owner = tree_data.get("owner", "?")
    repo = tree_data.get("repo", "?")
    ref = tree_data.get("ref", "?")
    path = tree_data.get("path")
    default_branch = tree_data.get("defaultBranch", "?")
    entries: list = tree_data.get("entries", [])
    total_count = tree_data.get("totalCount", 0)
    displayed_count = tree_data.get("displayedCount", 0)

    # Build metadata header
    lines: List[str] = []
    repo_full = f"{owner}/{repo}"

    if output_format == "markdown":
        lines.append(f"# Repository: {repo_full}")
        lines.append("")
        lines.append(f"- **Owner:** {owner}")
        lines.append(f"- **Repository:** {repo}")
        lines.append(f"- **Ref:** {ref}")
        if default_branch:
            lines.append(f"- **Default branch:** {default_branch}")
        if path:
            lines.append(f"- **Path:** {path}")
        lines.append(f"- **Entries:** {displayed_count}")
        lines.append("")
        lines.append("```")
        for entry in entries:
            entry_path = entry.get("path", "")
            entry_type = entry.get("type", "blob")
            suffix = "/" if entry_type == "tree" else ""
            lines.append(f"{entry_path}{suffix}")
        lines.append("```")
    else:
        # text mode
        lines.append(f"Repository: {repo_full}")
        lines.append(f"Owner: {owner}")
        lines.append(f"Ref: {ref}")
        if default_branch:
            lines.append(f"Default branch: {default_branch}")
        if path:
            lines.append(f"Path: {path}")
        lines.append(f"Entries: {displayed_count}")
        lines.append("")
        for entry in entries:
            entry_path = entry.get("path", "")
            entry_type = entry.get("type", "blob")
            suffix = "/" if entry_type == "tree" else ""
            lines.append(f"{entry_path}{suffix}")

    return "\n".join(lines)
