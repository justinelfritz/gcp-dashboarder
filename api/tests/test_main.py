from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz():
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_create_session_returns_unique_ids():
    a = client.post("/sessions")
    b = client.post("/sessions")
    assert a.status_code == 201
    assert len(a.json()["session_id"]) >= 32
    assert a.json()["session_id"] != b.json()["session_id"]
