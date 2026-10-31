import hashlib
import io
import secrets
from datetime import timedelta

import pandas as pd
import pytest
from conftest import RUN_START, build_run, fixture_bytes
from fastapi.testclient import TestClient

from app import uploads
from app.main import app, get_storage, settings
from app.parsing.fit_parser import parse_fit
from app.storage.backends import LocalStorage, PreconditionFailed
from app.storage.data_store import DataStore, merge_rows


@pytest.fixture
def storage(tmp_path):
    s = LocalStorage(str(tmp_path))
    app.dependency_overrides[get_storage] = lambda: s
    yield s
    app.dependency_overrides.clear()


@pytest.fixture
def client(storage):
    return TestClient(app)


@pytest.fixture
def session_id(client):
    return client.post("/sessions").json()["session_id"]


def upload(client, session_id, *files, **form):
    resp = client.post(
        f"/sessions/{session_id}/uploads",
        files=[("files", (name, io.BytesIO(data))) for name, data in files],
        data=form,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def activities(storage, session_id) -> pd.DataFrame:
    return DataStore.for_session(storage, session_id, 5000).load_activities()


def test_upload_garmin_csv_and_matching_fit_merges(client, storage, session_id, run_fit):
    body = upload(
        client, session_id,
        ("garmin.csv", fixture_bytes("garmin_activities_metric.csv")),
        ("run.fit", run_fit),
        timezone="America/Denver",
    )
    csv_report, fit_report = body["files"]
    assert csv_report["detected_format"] == "garmin_csv"
    assert csv_report["activities_added"] == 4
    assert csv_report["rows_rejected"] == 2
    assert fit_report["detected_format"] == "fit"
    assert fit_report["duplicates_merged"] == 1  # same run as the CSV's Morning Run
    assert body["total_activities"] == 4

    df = activities(storage, session_id)
    run = df[df.activity_type == "run"].iloc[0]
    assert run.source_format == "fit"  # FIT wins over CSV...
    assert run["name"] == "Morning Run"  # ...and fills gaps from it
    assert bool(run.has_records)
    records = storage.list(f"sessions/{session_id}/normalized/records/")
    assert records == [f"sessions/{session_id}/normalized/records/{run.activity_id}.parquet"]


def test_strava_and_garmin_csv_dedupe(client, storage, session_id):
    upload(client, session_id, ("garmin.csv", fixture_bytes("garmin_activities_metric.csv")),
           timezone="America/Denver")
    body = upload(client, session_id, ("activities.csv", fixture_bytes("strava_activities.csv")))
    [report] = body["files"]
    assert report["duplicates_merged"] == 1  # the Morning Run is in both exports
    assert report["activities_added"] == 3
    assert body["total_activities"] == 7


def test_reupload_is_skipped_by_content(client, storage, session_id, run_fit):
    upload(client, session_id, ("run.fit", run_fit))
    body = upload(client, session_id, ("renamed.fit", run_fit))
    report = body["files"][0]
    assert report["already_stored"] is True
    assert report["activities_added"] == 0
    assert body["total_activities"] == 1
    assert len(storage.list(f"sessions/{session_id}/raw/")) == 1


def test_same_activity_in_other_bytes_still_merges(client, session_id, run_fit):
    upload(client, session_id, ("run.fit", run_fit))
    # Different bytes (no per-second records) describing the same run: parsed, then merged.
    body = upload(client, session_id, ("again.fit", build_run(with_records=False)))
    assert body["files"][0]["already_stored"] is False
    assert body["files"][0]["duplicates_merged"] == 1


def test_upload_check_reports_known_hashes(client, session_id, run_fit):
    run_hash = hashlib.sha256(run_fit).hexdigest()
    bad = b"MZ not a fit file"
    upload(client, session_id, ("run.fit", run_fit), ("bad.fit", bad), ("garmin.csv",
           fixture_bytes("garmin_activities_metric.csv")))
    other = "0" * 64
    resp = client.post(f"/sessions/{session_id}/uploads/check",
                       json={"hashes": [run_hash, other, run_hash, hashlib.sha256(bad).hexdigest()]})
    # Rejected FIT files count as known too, so they aren't re-sent; CSVs are never recorded.
    assert resp.json() == {"known": [run_hash, hashlib.sha256(bad).hexdigest()]}
    bad_shape = client.post(f"/sessions/{session_id}/uploads/check", json={"hashes": ["xyz"]})
    assert bad_shape.status_code == 422


def test_rejections_are_retried_after_a_parser_change(client, storage, session_id, monkeypatch):
    bad = b"MZ not a fit file"
    upload(client, session_id, ("bad.fit", bad))
    monkeypatch.setattr(uploads, "REJECTED", "rejected@999")
    body = upload(client, session_id, ("bad.fit", bad))
    assert body["files"][0]["already_stored"] is False
    assert body["files"][0]["rejections"]


def test_csv_reupload_is_parsed_again(client, session_id):
    csv = fixture_bytes("garmin_activities_metric.csv")
    upload(client, session_id, ("garmin.csv", csv), units="metric")
    body = upload(client, session_id, ("garmin.csv", csv), units="metric")
    assert body["files"][0]["already_stored"] is False
    assert body["files"][0]["activities_parsed"] > 0


def test_library_summary(client, session_id, run_fit):
    empty = client.get(f"/sessions/{session_id}/library").json()
    assert empty == {"activities": 0, "visible_activities": 0, "first_date": None,
                     "last_date": None, "files_stored": 0, "bytes_stored": 0}
    upload(client, session_id, ("run.fit", run_fit),
           ("later.fit", build_run(start=RUN_START + timedelta(days=3))))
    lib = client.get(f"/sessions/{session_id}/library").json()
    assert lib["activities"] == 2
    assert lib["visible_activities"] == 2
    assert lib["files_stored"] == 2
    assert lib["bytes_stored"] > 0
    # RUN_START is 13:15 UTC, 07:15 local (UTC-6): the same calendar day.
    assert lib["first_date"] == RUN_START.strftime("%Y-%m-%d")
    assert lib["last_date"] == (RUN_START + timedelta(days=3)).strftime("%Y-%m-%d")


def test_bad_files_are_reported_not_fatal(client, session_id, run_fit):
    body = upload(
        client, session_id,
        ("notes.txt", b"hello"),
        ("evil.fit", b"MZ\x90\x00 not a fit file"),
        ("run.fit", run_fit),
    )
    txt, evil, good = body["files"]
    assert "unsupported file type" in txt["rejections"][0]["reason"]
    assert evil["rejections"][0]["reason"] == "file content is not FIT data"
    assert good["activities_added"] == 1


def test_oversized_file_rejected(client, session_id, run_fit, monkeypatch):
    monkeypatch.setattr(settings, "max_file_bytes", 100)
    body = upload(client, session_id, ("run.fit", run_fit))
    assert "exceeds" in body["files"][0]["rejections"][0]["reason"]


def test_session_file_limit(client, session_id, monkeypatch):
    monkeypatch.setattr(settings, "max_files_per_session", 1)
    body = upload(
        client, session_id,
        ("a.fit", build_run()),
        ("b.fit", build_run(start=RUN_START + timedelta(days=1))),
    )
    assert body["files"][0]["activities_added"] == 1
    assert "maximum of 1 files" in body["files"][1]["rejections"][0]["reason"]


@pytest.mark.parametrize("bad_id", ["short", "../../etc/passwd" + "x" * 16, "a" * 33])
def test_invalid_session_id(client, bad_id):
    resp = client.post(f"/sessions/{bad_id}/uploads", files=[("files", ("a.csv", b"x"))])
    assert resp.status_code in (404, 422)


def test_report_saved(client, storage, session_id, run_fit):
    body = upload(client, session_id, ("run.fit", run_fit))
    reports = storage.list(f"sessions/{session_id}/normalized/reports/")
    assert reports[0].endswith(f"{body['upload_id']}.json")


def test_merge_retries_on_concurrent_write(tmp_path, run_fit):
    class FlakyStorage(LocalStorage):
        failures = 1

        def write(self, path, data, content_type, if_generation=None):
            if if_generation is not None and self.failures:
                self.failures -= 1
                raise PreconditionFailed(path)
            super().write(path, data, content_type, if_generation)

    store = DataStore.for_session(FlakyStorage(str(tmp_path)), secrets.token_urlsafe(24), 5000)
    outcome = store.merge_activities(parse_fit(run_fit, "run.fit").activities)
    assert outcome.total == 1
    assert len(store.load_activities()) == 1


def test_merge_rows_keeps_existing_on_equal_priority():
    base = {"activity_type": "run", "start_time": pd.Timestamp("2024-03-10T13:15:22Z")}
    garmin = {**base, "activity_id": "g", "source_format": "garmin_csv", "name": None}
    strava = {**base, "activity_id": "s", "source_format": "strava_csv", "name": "Morning Run",
              "start_time": pd.Timestamp("2024-03-10T13:15:50Z")}
    rows, outcome = merge_rows([garmin], [strava])
    assert [r["activity_id"] for r in rows] == ["g"]
    assert rows[0]["name"] == "Morning Run"
    assert outcome.matched == {"s": "g"}
    assert outcome.added == set()


def test_merge_rows_different_types_not_merged():
    t = pd.Timestamp("2024-03-10T13:15:22Z")
    rows, _ = merge_rows(
        [{"activity_id": "a", "activity_type": "run", "start_time": t, "source_format": "fit"}],
        [{"activity_id": "b", "activity_type": "ride", "start_time": t, "source_format": "fit"}],
    )
    assert len(rows) == 2
