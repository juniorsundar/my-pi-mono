#!/usr/bin/env python3
"""Pi web-search helper: calls SearXNG JSON API and prints JSON results."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, List, Optional
from urllib.parse import urlencode

import httpx


SAFESEARCH_MAP = {"off": 0, "moderate": 1, "on": 2}
TIMELIMIT_MAP = {"d": "day", "w": "week", "m": "month", "y": "year"}

SEARXNG_TIMEOUT = 15  # seconds — SearXNG aggregates multiple engines


CATEGORIES_CHOICES = ["general", "it", "news", "science", "files", "social media"]
LANGUAGE_CHOICES = ["all", "en", "de", "fr", "es", "pt", "zh", "ja", "ko", "ar", "ru"]


def normalize_result(result: dict[str, Any]) -> dict[str, Any]:
    """Normalize a SearXNG result dict into the output shape.

    Keeps: title, href, body, publishedDate, engines.
    Excludes: score, category, infoboxes.
    Missing fields default to empty string or empty list.
    """
    engines_raw = result.get("engines")
    engines = list(engines_raw) if isinstance(engines_raw, list) else []
    return {
        "title": str(result.get("title") or ""),
        "href": str(result.get("url") or ""),
        "body": str(result.get("content") or ""),
        "publishedDate": str(result.get("publishedDate") or ""),
        "engines": engines,
    }


def build_searxng_url(base_url: str, args: argparse.Namespace) -> str:
    """Build the SearXNG /search?format=json URL from CLI args."""
    base = base_url.rstrip("/")
    params: dict[str, str] = {
        "format": "json",
        "q": args.query,
        "safesearch": str(SAFESEARCH_MAP.get(args.safesearch, 1)),
    }

    if args.language:
        params["language"] = args.language

    if args.categories:
        params["categories"] = args.categories

    if args.timelimit:
        params["time_range"] = TIMELIMIT_MAP.get(args.timelimit, args.timelimit)

    return f"{base}/search?{urlencode(params)}"


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--searxng-url", required=True, help="SearXNG instance base URL")
    parser.add_argument("--query", "-q", required=True)
    parser.add_argument("--max-results", "-m", type=int, default=10)
    parser.add_argument("--language", choices=LANGUAGE_CHOICES, default="all")
    parser.add_argument("--categories", choices=CATEGORIES_CHOICES, default=None)
    parser.add_argument("--safesearch", choices=["on", "moderate", "off"], default="moderate")
    parser.add_argument("--timelimit", choices=["d", "w", "m", "y"], default=None)
    args = parser.parse_args(argv)

    url = build_searxng_url(args.searxng_url, args)

    try:
        response = httpx.get(url, timeout=SEARXNG_TIMEOUT)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        print(json.dumps({"error": f"SearXNG request failed: {exc}"}, ensure_ascii=False))
        return 1

    try:
        data = response.json()
    except ValueError:
        print(json.dumps({"error": "SearXNG returned non-JSON response"}, ensure_ascii=False))
        return 1

    results = data.get("results") or []
    max_results = max(1, min(args.max_results, 20))
    normalized = [normalize_result(r) for r in results[:max_results]]

    answers = data.get("answers") or []
    corrections = data.get("corrections") or []
    suggestions = data.get("suggestions") or []

    output: dict[str, Any] = {
        "results": normalized,
        "answers": answers,
        "corrections": corrections,
        "suggestions": suggestions,
    }

    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
