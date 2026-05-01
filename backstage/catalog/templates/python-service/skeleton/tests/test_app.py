from fastapi.testclient import TestClient
from src.main import app

client = TestClient(app)


def test_healthz():
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready():
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_root():
    response = client.get("/")
    assert response.status_code == 200
    assert "status" in response.json()


def test_metrics():
    response = client.get("/metrics")
    assert response.status_code == 200
