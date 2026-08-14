"""API-level tests for ${{ values.name }}.

The graph itself is stubbed. What is asserted here is the contract the endpoint
promises — shape, validation, and that a failing run surfaces as a 500 rather
than a 200 with an empty answer.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


@pytest.fixture
def mock_run_agent():
    with patch("src.main.run_agent", new_callable=AsyncMock) as m:
        m.return_value = {
            "answer": "hello-service is healthy",
            "plan": "check the service metrics",
            "tools_used": ["get_service_metrics"],
            "iterations": 1,
        }
        yield m


@pytest.fixture(autouse=True)
def _no_mcp():
    # Never reach for real MCP servers in a unit test.
    with patch("src.main.load_mcp_tools", new_callable=AsyncMock) as m:
        m.return_value = []
        yield m


def test_healthz():
    assert client.get("/healthz").json() == {"status": "ok"}


def test_ready_reports_tool_count_and_stays_ready_with_none():
    body = client.get("/ready").json()
    assert body["status"] == "ready"
    # A core-only cluster has no MCP servers; that must not make the pod
    # unready, or it stays out of service for a non-error.
    assert body["mcp_tools"] == 0


def test_ask_returns_the_full_shape(mock_run_agent):
    r = client.post("/ask", json={"question": "is hello-service healthy?"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "hello-service is healthy"
    assert body["plan"] == "check the service metrics"
    assert body["tools_used"] == ["get_service_metrics"]
    assert body["iterations"] == 1
    assert "trace_id" in body


def test_ask_passes_the_thread_id_through(mock_run_agent):
    client.post("/ask", json={"question": "hi", "thread_id": "abc123"})
    assert mock_run_agent.call_args.args[1] == "abc123"


def test_ask_rejects_an_empty_question():
    assert client.post("/ask", json={"question": ""}).status_code == 422


def test_ask_rejects_an_oversized_question():
    assert client.post("/ask", json={"question": "x" * 5000}).status_code == 422


def test_a_failing_run_is_a_500_not_an_empty_200(mock_run_agent):
    mock_run_agent.side_effect = RuntimeError("model unreachable")
    r = client.post("/ask", json={"question": "hi"})
    assert r.status_code == 500
    assert "model unreachable" in r.json()["detail"]


def test_metrics_exposes_the_run_counter(mock_run_agent):
    client.post("/ask", json={"question": "hi"})
    assert "agent_runs_total" in client.get("/metrics").text
