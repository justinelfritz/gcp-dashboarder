import hashlib
import io
from datetime import timedelta

import pytest
from conftest import RUN_START, build_run
from fastapi.testclient import TestClient

from app.auth import get_token_verifier
from app.main import app, get_storage, settings
from app.storage.backends import LocalStorage

TOKENS = {"token-alice": "alice", "token-bob": "bob", "token-weird": "../../etc"}


def fake_verify(token: str) -> dict:
    if token == "token-password-only":
        return {"uid": "carol", "firebase": {"sign_in_provider": "password"}}
    if token not in TOKENS:
        raise ValueError("bad token")
    return {"uid": TOKENS[token],
            "firebase": {"sign_in_provider": "password", "sign_in_second_factor": "totp"}}


@pytest.fixture
def storage(tmp_path):
    s = LocalStorage(str(tmp_path))
    app.dependency_overrides[get_storage] = lambda: s
    app.dependency_overrides[get_token_verifier] = lambda: fake_verify
    yield s
    app.dependency_overrides.clear()


@pytest.fixture
def client(storage):
    return TestClient(app)


def auth(user: str) -> dict:
    return {"Authorization": f"Bearer token-{user}"}


def upload(client, base, *files, headers=None):
    resp = client.post(f"{base}/uploads", headers=headers or {},
                       files=[("files", (name, io.BytesIO(data))) for name, data in files])
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_me_routes_need_a_valid_token(client):
    assert client.get("/me/library").status_code == 401
    assert client.get("/me/library", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/me/library", headers={"Authorization": "Basic token-alice"}).status_code == 401
    # A UID that could escape the user's storage prefix is refused.
    assert client.get("/me/library", headers=auth("weird")).status_code == 401
    assert client.get("/me/library", headers=auth("alice")).status_code == 200


def test_second_factor_required(client, monkeypatch):
    # A password-only sign-in (no authenticator code yet) can't reach any data.
    resp = client.get("/me/library", headers=auth("password-only"))
    assert resp.status_code == 403
    assert "authenticator" in resp.json()["detail"]
    monkeypatch.setattr(settings, "require_second_factor", False)  # local emulator runs only
    assert client.get("/me/library", headers=auth("password-only")).status_code == 200


def test_sign_in_disabled_without_a_firebase_project(storage, monkeypatch):
    del app.dependency_overrides[get_token_verifier]
    monkeypatch.setattr(settings, "firebase_project_id", "")
    resp = TestClient(app).get("/me/library", headers=auth("alice"))
    assert resp.status_code == 503


def test_users_only_see_their_own_data(client, storage, run_fit):
    upload(client, "/me", ("run.fit", run_fit), headers=auth("alice"))
    assert client.get("/me/library", headers=auth("alice")).json()["activities"] == 1
    assert client.get("/me/library", headers=auth("bob")).json()["activities"] == 0
    assert client.get("/me/activities", headers=auth("bob")).json()["total"] == 0
    check = client.post("/me/uploads/check", headers=auth("bob"),
                        json={"hashes": [hashlib.sha256(run_fit).hexdigest()]})
    assert check.json() == {"known": []}
    assert storage.list("users/alice/raw/") and not storage.list("users/bob/")


def test_user_file_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "max_files_per_user", 1)
    body = upload(client, "/me", ("a.fit", build_run()),
                  ("b.fit", build_run(start=RUN_START + timedelta(days=1))), headers=auth("alice"))
    assert body["files"][0]["activities_added"] == 1
    assert "maximum of 1 files" in body["files"][1]["rejections"][0]["reason"]


def test_claim_guest_session_merges_into_the_account(client, storage, run_fit):
    later = build_run(start=RUN_START + timedelta(days=2))
    sid = client.post("/sessions").json()["session_id"]
    upload(client, f"/sessions/{sid}", ("run.fit", run_fit), ("later.fit", later))
    # Alice already has the first run from another device.
    upload(client, "/me", ("run.fit", run_fit), headers=auth("alice"))

    resp = client.post("/me/claim-session", headers=auth("alice"), json={"session_id": sid})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"activities_added": 1, "duplicates_merged": 1, "total_activities": 2}

    lib = client.get("/me/library", headers=auth("alice")).json()
    assert lib["activities"] == 2 and lib["files_stored"] == 2
    # The claimed run's per-second data and manifest entry came along.
    assert len(storage.list("users/alice/normalized/records/")) == 2

    known = client.post("/me/uploads/check", headers=auth("alice"),
                        json={"hashes": [hashlib.sha256(later).hexdigest()]}).json()["known"]
    assert known == [hashlib.sha256(later).hexdigest()]
    # Claiming again changes nothing.
    again = client.post("/me/claim-session", headers=auth("alice"), json={"session_id": sid})
    assert again.json()["activities_added"] == 0


def test_claim_needs_sign_in_and_a_real_session(client):
    sid = "a" * 32
    assert client.post("/me/claim-session", json={"session_id": sid}).status_code == 401
    missing = client.post("/me/claim-session", headers=auth("alice"), json={"session_id": sid})
    assert missing.status_code == 404
    bad = client.post("/me/claim-session", headers=auth("alice"), json={"session_id": "../x"})
    assert bad.status_code == 422


def test_guest_routes_unchanged(client, run_fit):
    sid = client.post("/sessions").json()["session_id"]
    body = upload(client, f"/sessions/{sid}", ("run.fit", run_fit))
    assert body["total_activities"] == 1
    assert client.get(f"/sessions/{sid}/library").json()["activities"] == 1
