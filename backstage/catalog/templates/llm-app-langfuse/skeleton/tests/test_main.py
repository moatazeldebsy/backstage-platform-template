import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)


def test_healthz():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready_reports_configuration():
    response = client.get("/ready")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    # The service no longer holds a provider key — it routes through the AI
    # Gateway, which does. What readiness reports is where model calls go.
    assert "ai-gateway" in body["llm_base_url"]
    # Tracing is off in tests (LANGFUSE_OTLP_ENDPOINT unset) — the readiness
    # probe must still pass. Tracing is observability, not a dependency.
    assert body["tracing_enabled"] is False


def test_metrics_exposes_prometheus_format():
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "http_requests_total" in response.text


def test_chat_returns_reply_and_usage(mock_anthropic):
    response = client.post("/chat", json={"message": "Hi"})
    assert response.status_code == 200
    body = response.json()
    assert body["reply"] == "Hello from the model."
    assert body["input_tokens"] == 12
    assert body["output_tokens"] == 34


def test_chat_passes_model_and_effort(mock_anthropic):
    from src import main

    client.post("/chat", json={"message": "Hi"})
    kwargs = mock_anthropic.messages.create.call_args.kwargs
    assert kwargs["model"] == main.MODEL
    assert kwargs["output_config"] == {"effort": main.EFFORT}
    # Sampling params are rejected on current models — a stray temperature
    # would 400 in production but pass a mocked test, so assert their absence.
    assert "temperature" not in kwargs
    assert "top_p" not in kwargs


def test_chat_rejects_empty_message():
    response = client.post("/chat", json={"message": ""})
    assert response.status_code == 422


def test_chat_handles_refusal(mock_anthropic, fake_message):
    """A refusal is HTTP 200 with empty content — not an SDK exception.

    Reading content[0] unconditionally would raise IndexError here, so this
    pins the stop_reason check that prevents it.
    """
    mock_anthropic.messages.create.return_value = fake_message(
        text=None, stop_reason="refusal"
    )
    response = client.post("/chat", json={"message": "..."})
    assert response.status_code == 422
    assert "declined" in response.json()["detail"]


def test_chat_maps_connection_error_to_503(mock_anthropic):
    mock_anthropic.messages.create.side_effect = anthropic.APIConnectionError(
        request=None
    )
    response = client.post("/chat", json={"message": "Hi"})
    assert response.status_code == 503


@pytest.mark.parametrize(
    ("upstream_status", "expected"),
    [
        (429, 429),  # rate limited — retryable, pass it through
        (500, 500),  # provider fault — retryable
        (400, 502),  # our request was bad; don't tell the caller to retry
    ],
)
def test_chat_maps_api_status_errors(mock_anthropic, upstream_status, expected):
    # APIStatusError reads response.request in its constructor, so a duck-typed
    # stub is not enough — build a real httpx.Response.
    upstream = httpx.Response(
        upstream_status,
        request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"),
    )
    mock_anthropic.messages.create.side_effect = anthropic.APIStatusError(
        "upstream failure", response=upstream, body=None
    )
    response = client.post("/chat", json={"message": "Hi"})
    assert response.status_code == expected


def test_client_defaults_to_the_ai_gateway(monkeypatch):
    """No provider key needed: the gateway holds it and injects it upstream.

    This replaces an earlier test asserting a 503 when ANTHROPIC_API_KEY was
    unset. That behaviour is gone on purpose — needing a per-service `sk-ant-`
    secret was the friction the gateway removes.
    """
    from src import main

    monkeypatch.setattr(main, "_client", None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)

    built = main.get_client()
    assert "ai-gateway.ml-platform.svc.cluster.local:3000" in str(built.base_url)


def test_base_url_override_bypasses_the_gateway(monkeypatch):
    """Escape hatch for local development outside the cluster."""
    from src import main

    monkeypatch.setattr(main, "_client", None)
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-key-not-real")

    built = main.get_client()
    assert "api.anthropic.com" in str(built.base_url)
