import gzip
from datetime import timedelta

import pytest
from conftest import RUN_START, add_records, add_session, build_run
from fit_builder import FitBuilder

from app.parsing.fit_parser import gunzip_capped, parse_fit


def test_parses_session_summary(run_fit):
    result = parse_fit(run_fit, "run.fit")
    assert result.rejected == []
    [a] = result.activities
    assert a["start_time"] == RUN_START
    assert a["activity_type"] == "run"
    assert a["raw_activity_type"] == "running"
    assert a["duration_s"] == 60.0
    assert a["distance_m"] == 180.0
    assert a["avg_hr"] == 150 and a["max_hr"] == 160
    assert a["avg_speed_mps"] == 3.0
    assert a["elevation_gain_m"] == 12
    assert a["calories"] == 50
    assert a["avg_power_w"] is None  # absent in file -> null, not an error
    assert a["tz_offset_min"] == -360
    assert a["has_records"] is True


def test_parses_records(run_fit):
    result = parse_fit(run_fit, "run.fit")
    [a] = result.activities
    rows = result.records[a["activity_id"]]
    assert len(rows) == 60
    first = rows[0]
    assert first["elapsed_s"] == 0.0
    assert first["hr"] == 150
    assert first["speed"] == 3.0
    assert first["lat"] == pytest.approx(39.74, abs=1e-6)
    assert first["lon"] == pytest.approx(-104.99, abs=1e-6)
    assert rows[-1]["distance_m"] == pytest.approx(177.0)


def test_activity_id_is_deterministic(run_fit):
    assert (
        parse_fit(run_fit, "a.fit").activities[0]["activity_id"]
        == parse_fit(run_fit, "b.fit").activities[0]["activity_id"]
    )


def test_gzipped_fit():
    result = parse_fit(gzip.compress(build_run()), "run.fit.gz")
    assert len(result.activities) == 1


def test_multisport_splits_records_by_session():
    t0 = RUN_START
    t1 = t0 + timedelta(seconds=30)
    b = FitBuilder().add("file_id", type=4, manufacturer=1, product=1, serial_number=1,
                         time_created=t0)
    add_records(b, t0, 30, speed=8.0, power=200)
    add_records(b, t1, 20, speed=3.0)
    add_session(b, t0, 29, "cycling", avg_power=200)
    add_session(b, t1, 19, "running")
    result = parse_fit(b.build(), "brick.fit")
    ride, run = result.activities
    assert (ride["activity_type"], run["activity_type"]) == ("ride", "run")
    assert ride["avg_power_w"] == 200
    assert len(result.records[ride["activity_id"]]) == 30
    assert len(result.records[run["activity_id"]]) == 20


def test_strength_sub_sport():
    b = FitBuilder()
    add_session(b, RUN_START, 1800, "training", sub_sport="strength_training")
    [a] = parse_fit(b.build(), "lift.fit").activities
    assert a["activity_type"] == "strength"
    assert a["raw_activity_type"] == "training/strength_training"
    assert a["has_records"] is False
    assert a["tz_offset_min"] is None


def test_summary_derived_from_records_when_no_session():
    b = FitBuilder()
    add_records(b, RUN_START, 10)
    result = parse_fit(b.build(), "nosession.fit")
    [a] = result.activities
    assert a["duration_s"] == 9.0
    assert a["avg_hr"] == 150
    assert any("derived from records" in w for w in result.warnings)


def test_truncated_file_does_not_raise(run_fit):
    result = parse_fit(run_fit[: len(run_fit) // 2], "cut.fit")
    # Session is at the end, so it's lost; the summary falls back to records with a warning.
    assert result.warnings
    assert len(result.activities) <= 1


def test_not_fit_is_rejected():
    result = parse_fit(b"MZ\x90\x00 definitely not fit data", "evil.fit")
    assert result.activities == []
    assert result.rejected[0].reason == "not a FIT file"


def test_gzip_bomb_guard():
    bomb = gzip.compress(b"\x00" * 10_000)
    with pytest.raises(ValueError, match="exceeds"):
        gunzip_capped(bomb, limit=1_000)
