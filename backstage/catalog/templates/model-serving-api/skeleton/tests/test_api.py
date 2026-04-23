import pytest
from fastapi.testclient import TestClient
from src.main import app

client = TestClient(app)


def test_healthz():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_ready():
    resp = client.get("/ready")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ready"


def test_metrics():
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert "http_requests_total" in resp.text


def test_predict_stub():
    """With no MODEL_URI set, the stub predictor echoes back inputs."""
    resp = client.post("/v1/predict", json={"inputs": [1, 2, 3]})
    assert resp.status_code == 200
    assert resp.json()["predictions"] == [1, 2, 3]
