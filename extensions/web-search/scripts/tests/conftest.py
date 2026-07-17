"""Shared test fixtures for web-search script tests.

Patches socket.getaddrinfo so SSRF checks in fetch.py work without real DNS.
This makes the entire test suite deterministic and offline.
"""

from __future__ import annotations

import socket

import pytest


# A well-known public IP (example.com) used for all mocked DNS lookups.
_PUBLIC_ADDRINFO = [
    (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", 80)),
]


@pytest.fixture(autouse=True)
def _mock_dns(monkeypatch):
    """Prevent real DNS resolution during tests.

    fetch.py's SSRF guard calls socket.getaddrinfo before making HTTP
    requests. Without this fixture, tests fail in environments without
    DNS access even though the HTTP layer is mocked by pytest-httpx.
    """
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: _PUBLIC_ADDRINFO)