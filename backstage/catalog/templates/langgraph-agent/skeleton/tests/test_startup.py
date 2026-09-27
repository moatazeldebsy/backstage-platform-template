"""Startup: the app's lifespan must run, or the container never serves traffic.

The other API tests build a TestClient without entering it, which skips the
lifespan entirely — and that is how a bad init_tracing() call shipped: every
unit test passed while the container crashed on boot. Entering the client here
runs startup and shutdown for real (MCP tool loading is stubbed).
"""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from src.main import app


def test_app_starts_up_and_serves_health_checks():
    with patch("src.main.load_mcp_tools", new_callable=AsyncMock, return_value=[]):
        with TestClient(app) as client:
            assert client.get("/healthz").status_code == 200
            assert client.get("/ready").status_code == 200
