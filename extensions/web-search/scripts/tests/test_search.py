"""Tests for search.py — SearXNG search backend."""

from __future__ import annotations

import json
import httpx
import pytest
from search import main, normalize_result


# ---------------------------------------------------------------------------
# Unit: result normalization
# ---------------------------------------------------------------------------


def test_normalize_result_maps_searxng_fields():
    """SearXNG result fields url/title/content map to href/title/body; includes publishedDate and engines."""
    normalized = normalize_result({
        "url": "https://example.com",
        "title": "Example Title",
        "content": "Example snippet.",
        "engines": ["google", "duckduckgo"],
        "score": 0.95,
        "publishedDate": "2024-01-01",
    })
    assert normalized == {
        "title": "Example Title",
        "href": "https://example.com",
        "body": "Example snippet.",
        "publishedDate": "2024-01-01",
        "engines": ["google", "duckduckgo"],
    }
    assert "score" not in normalized
    assert "category" not in normalized
    assert "infoboxes" not in normalized


def test_normalize_result_handles_missing_fields():
    """Missing fields default to empty strings or empty lists."""
    assert normalize_result({}) == {
        "title": "", "href": "", "body": "",
        "publishedDate": "", "engines": [],
    }


def test_normalize_result_handles_none_values():
    """None values become empty strings or empty lists."""
    normalized = normalize_result({
        "url": None,
        "title": None,
        "content": None,
    })
    assert normalized == {
        "title": "", "href": "", "body": "",
        "publishedDate": "", "engines": [],
    }


# ---------------------------------------------------------------------------
# Integration: CLI → SearXNG API → JSON output
# ---------------------------------------------------------------------------


def test_search_happy_path_returns_results(httpx_mock, capsys):
    """Full CLI invocation: correct SearXNG URL, JSON output with results."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test+query&safesearch=1&language=all",
        json={
            "query": "test query",
            "number_of_results": 2,
            "results": [
                {
                    "title": "First Result",
                    "url": "https://first.example.com",
                    "content": "First snippet.",
                },
                {
                    "title": "Second Result",
                    "url": "https://second.example.com",
                    "content": "Second snippet.",
                },
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test query",
        "--max-results", "10",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert "results" in output
    assert len(output["results"]) == 2
    assert output["results"][0] == {
        "title": "First Result",
        "href": "https://first.example.com",
        "body": "First snippet.",
        "publishedDate": "",
        "engines": [],
    }
    assert output["results"][1] == {
        "title": "Second Result",
        "href": "https://second.example.com",
        "body": "Second snippet.",
        "publishedDate": "",
        "engines": [],
    }


def test_search_max_results_slices_client_side(httpx_mock, capsys):
    """maxResults is enforced client-side by slicing the response."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 5,
            "results": [
                {"title": f"R{i}", "url": f"https://{i}.com", "content": f"S{i}"}
                for i in range(5)
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--max-results", "3",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert len(output["results"]) == 3


def test_search_empty_results(httpx_mock, capsys):
    """SearXNG returns no results → empty results list, no error."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=nothing&safesearch=1&language=all",
        json={
            "query": "nothing",
            "number_of_results": 0,
            "results": [],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "nothing",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert output["results"] == []


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def test_unreachable_instance_produces_clear_error(httpx_mock, capsys):
    """Connection refused → JSON error, exit code 1."""
    # Not adding a mock response → httpx will raise ConnectError
    # when pytest-httpx's can_send is False for unmatched requests.
    httpx_mock.add_exception(
        httpx.ConnectError("Connection refused"),
        url="http://127.0.0.1:9999/search?format=json&q=test&safesearch=1&language=all",
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:9999",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 1
    assert "error" in output
    assert "SearXNG request failed" in output["error"]


def test_http_error_response_produces_error(httpx_mock, capsys):
    """HTTP 500 → JSON error, exit code 1."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        status_code=500,
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 1
    assert "error" in output
    assert "SearXNG request failed" in output["error"]


def test_non_json_response_produces_error(httpx_mock, capsys):
    """Non-JSON response → JSON error, exit code 1."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        text="<html>Internal Server Error</html>",
        headers={"content-type": "text/html"},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 1
    assert "error" in output
    assert "non-JSON" in output["error"]


def test_negative_max_results_clamped(httpx_mock, capsys):
    """Negative --max-results is clamped to 1 (no negative slicing)."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 2,
            "results": [
                {"title": "R1", "url": "https://1.com", "content": "S1"},
                {"title": "R2", "url": "https://2.com", "content": "S2"},
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--max-results", "-1",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    # Must return exactly 1 result (clamped from -1 → 1).
    # Negative slicing (results[:-1]) would return [R1] which looks right
    # for a 2-item list but is wrong for other sizes. We verify the
    # first result is R1, confirming forward slicing (results[:1]).
    assert len(output["results"]) == 1
    assert output["results"][0]["title"] == "R1"


# ---------------------------------------------------------------------------
# Parameter mapping
# ---------------------------------------------------------------------------


def test_safesearch_on_maps_to_2(httpx_mock, capsys):
    """safesearch 'on' → SearXNG safesearch=2."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=2&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--safesearch", "on",
    ])

    assert exit_code == 0


def test_safesearch_off_maps_to_0(httpx_mock, capsys):
    """safesearch 'off' → SearXNG safesearch=0."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=0&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--safesearch", "off",
    ])

    assert exit_code == 0


def test_timelimit_d_maps_to_day(httpx_mock, capsys):
    """timelimit 'd' → SearXNG time_range=day."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&time_range=day&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--timelimit", "d",
    ])

    assert exit_code == 0


def test_timelimit_w_maps_to_week(httpx_mock, capsys):
    """timelimit 'w' → SearXNG time_range=week."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&time_range=week&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--timelimit", "w",
    ])

    assert exit_code == 0


def test_timelimit_not_specified_omits_time_range(httpx_mock, capsys):
    """No --timelimit → SearXNG URL has no time_range param."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    assert exit_code == 0


@pytest.mark.parametrize("lang", [
    "all", "en", "de", "fr", "es", "pt", "zh", "ja", "ko", "ar", "ru",
])
def test_language_passthrough(httpx_mock, capsys, lang):
    """--language <value> appears as language=<value> in the SearXNG URL for all 11 values."""
    httpx_mock.add_response(
        url=f"http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language={lang}",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--language", lang,
    ])

    assert exit_code == 0


# ---------------------------------------------------------------------------
# Additional edge-case coverage (post-review)
# ---------------------------------------------------------------------------


def test_region_argument_rejected(capsys):
    """--region is rejected (no longer accepted)."""
    with pytest.raises(SystemExit) as exc:
        main([
            "--searxng-url", "http://127.0.0.1:5340",
            "--query", "test",
            "--region", "us-en",
        ])
    assert exc.value.code == 2


def test_results_null_handled_as_empty(httpx_mock, capsys):
    """SearXNG returns 'results': null → treated as empty list."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={"query": "test", "number_of_results": 0, "results": None},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert output["results"] == []


def test_max_results_upper_bound_clamped(httpx_mock, capsys):
    """--max-results 100 → clamped to 20 in Python."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 25,
            "results": [
                {"title": f"R{i}", "url": f"https://{i}.com", "content": f"S{i}"}
                for i in range(25)
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--max-results", "100",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert len(output["results"]) == 20


def test_negative_max_results_with_many_results(httpx_mock, capsys):
    """Negative --max-results with 5 results definitively proves forward slicing."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 5,
            "results": [
                {"title": f"R{i}", "url": f"https://{i}.com", "content": f"S{i}"}
                for i in range(5)
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--max-results", "-1",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    # Clamped to 1: forward slicing gives [R0], negative slicing would give [R4].
    assert len(output["results"]) == 1
    assert output["results"][0]["title"] == "R0"


def test_timeout_produces_clear_error(httpx_mock, capsys):
    """httpx.TimeoutException → JSON error, exit code 1."""
    httpx_mock.add_exception(
        httpx.TimeoutException("Request timed out"),
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 1
    assert "error" in output
    assert "SearXNG request failed" in output["error"]


def test_timelimit_m_maps_to_month(httpx_mock, capsys):
    """timelimit 'm' → SearXNG time_range=month."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&time_range=month&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--timelimit", "m",
    ])

    assert exit_code == 0


def test_timelimit_y_maps_to_year(httpx_mock, capsys):
    """timelimit 'y' → SearXNG time_range=year."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&time_range=year&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--timelimit", "y",
    ])

    assert exit_code == 0


def test_safesearch_moderate_maps_to_1(httpx_mock, capsys):
    """safesearch 'moderate' (explicit) → SearXNG safesearch=1."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--safesearch", "moderate",
    ])

    assert exit_code == 0


# ---------------------------------------------------------------------------
# Categories parameter (0046)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("cat,expected", [
    ("general", "categories=general"),
    ("it", "categories=it"),
    ("news", "categories=news"),
    ("science", "categories=science"),
    ("files", "categories=files"),
    ("social media", "categories=social%20media"),
])
def test_categories_is_passed_to_searxng_url(httpx_mock, capsys, cat, expected):
    """--categories <value> appears as categories=<value> in the SearXNG URL."""
    httpx_mock.add_response(
        url=f"http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&{expected}&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
        "--categories", cat,
    ])

    assert exit_code == 0


def test_categories_default_not_sent_to_searxng(httpx_mock, capsys):
    """No --categories → no categories param (SearXNG defaults to 'general')."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={"query": "test", "number_of_results": 0, "results": []},
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    assert exit_code == 0


def test_categories_invalid_value_rejected(capsys):
    """Invalid --categories value → argparse error, exit code 2."""
    with pytest.raises(SystemExit) as exc:
        main([
            "--searxng-url", "http://127.0.0.1:5340",
            "--query", "test",
            "--categories", "bogus",
        ])
    assert exc.value.code == 2


# ---------------------------------------------------------------------------
# Enriched response format (0046)
# ---------------------------------------------------------------------------


def test_normalize_result_includes_published_date_and_engines():
    """normalize_result keeps publishedDate and engines from SearXNG result."""
    normalized = normalize_result({
        "url": "https://example.com",
        "title": "Example Title",
        "content": "Example snippet.",
        "engines": ["google", "duckduckgo"],
        "publishedDate": "2024-01-01T12:00:00Z",
        "score": 0.95,
        "category": "general",
        "infoboxes": ["some info"],
    })
    assert normalized["title"] == "Example Title"
    assert normalized["href"] == "https://example.com"
    assert normalized["body"] == "Example snippet."
    assert normalized["publishedDate"] == "2024-01-01T12:00:00Z"
    assert normalized["engines"] == ["google", "duckduckgo"]
    assert "score" not in normalized
    assert "category" not in normalized
    assert "infoboxes" not in normalized


def test_normalize_result_excludes_noise_fields():
    """normalize_result excludes score, category, infoboxes even when present."""
    normalized = normalize_result({
        "url": "https://x.com",
        "title": "X",
        "content": "X content",
        "score": 0.5,
        "category": "news",
        "infoboxes": ["something"],
    })
    assert "score" not in normalized
    assert "category" not in normalized
    assert "infoboxes" not in normalized


def test_normalize_result_missing_enrichment_fields_default_to_empty():
    """When publishedDate and engines are missing, defaults are empty string and empty list."""
    normalized = normalize_result({
        "url": "https://y.com",
        "title": "Y",
        "content": "Y content",
    })
    assert normalized["publishedDate"] == ""
    assert normalized["engines"] == []


def test_response_includes_answers_corrections_suggestions(httpx_mock, capsys):
    """Top-level JSON output includes answers, corrections, suggestions from SearXNG."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=population+of+france&safesearch=1&language=all",
        json={
            "query": "population of france",
            "number_of_results": 1,
            "results": [
                {
                    "title": "France population",
                    "url": "https://example.com/france",
                    "content": "France has 68M people.",
                },
            ],
            "answers": ["France has a population of approximately 68 million."],
            "corrections": ["population of france"],
            "suggestions": ["population of germany", "france demographics"],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "population of france",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert "answers" in output
    assert output["answers"] == ["France has a population of approximately 68 million."]
    assert "corrections" in output
    assert output["corrections"] == ["population of france"]
    assert "suggestions" in output
    assert output["suggestions"] == ["population of germany", "france demographics"]


def test_response_missing_enrichment_fields_default_gracefully(httpx_mock, capsys):
    """When SearXNG returns no answers/corrections/suggestions, defaults are empty lists."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 0,
            "results": [],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert output["answers"] == []
    assert output["corrections"] == []
    assert output["suggestions"] == []


def test_response_results_include_published_date_and_engines(httpx_mock, capsys):
    """Each result in the JSON output includes publishedDate and engines."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 1,
            "results": [
                {
                    "title": "R1",
                    "url": "https://r1.com",
                    "content": "Snippet 1",
                    "engines": ["google", "duckduckgo"],
                    "publishedDate": "2024-06-01T10:00:00Z",
                },
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert len(output["results"]) == 1
    result = output["results"][0]
    assert result["publishedDate"] == "2024-06-01T10:00:00Z"
    assert result["engines"] == ["google", "duckduckgo"]
    assert "score" not in result
    assert "category" not in result


def test_response_results_missing_published_date_defaults_to_empty(httpx_mock, capsys):
    """When a result has no publishedDate, it defaults to empty string."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 1,
            "results": [
                {
                    "title": "R1",
                    "url": "https://r1.com",
                    "content": "Snippet 1",
                },
            ],
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert output["results"][0]["publishedDate"] == ""
    assert output["results"][0]["engines"] == []


def test_language_invalid_value_rejected(capsys):
    """Invalid --language value → argparse error, exit code 2."""
    with pytest.raises(SystemExit) as exc:
        main([
            "--searxng-url", "http://127.0.0.1:5340",
            "--query", "test",
            "--language", "bogus",
        ])
    assert exc.value.code == 2


def test_response_null_enrichment_fields_default_gracefully(httpx_mock, capsys):
    """When SearXNG returns null for enrichment fields, they default to empty lists."""
    httpx_mock.add_response(
        url="http://127.0.0.1:5340/search?format=json&q=test&safesearch=1&language=all",
        json={
            "query": "test",
            "number_of_results": 0,
            "results": [],
            "answers": None,
            "corrections": None,
            "suggestions": None,
        },
    )

    exit_code = main([
        "--searxng-url", "http://127.0.0.1:5340",
        "--query", "test",
    ])

    captured = capsys.readouterr()
    output = json.loads(captured.out)

    assert exit_code == 0
    assert output["answers"] == []
    assert output["corrections"] == []
    assert output["suggestions"] == []
