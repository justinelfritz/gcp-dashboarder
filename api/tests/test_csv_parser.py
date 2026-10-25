from datetime import UTC, datetime

import pytest
from conftest import RUN_START, fixture_bytes

from app.parsing.csv_parser import parse_csv


@pytest.fixture
def garmin_metric():
    return parse_csv(
        fixture_bytes("garmin_activities_metric.csv"), "garmin.csv", timezone="America/Denver"
    )


def by_type(result, activity_type):
    return next(a for a in result.activities if a["activity_type"] == activity_type)


def test_garmin_detects_format_and_rejects_bad_rows(garmin_metric):
    assert garmin_metric.source_format == "garmin_csv"
    assert len(garmin_metric.activities) == 4
    assert [(e.row, e.reason) for e in garmin_metric.rejected] == [
        (6, "unrecognized date 'not-a-date'"),
        (7, "not a number: 'abc'"),
    ]


def test_garmin_run(garmin_metric):
    run = by_type(garmin_metric, "run")
    assert run["start_time"] == RUN_START  # 07:15:22 MDT -> UTC
    assert run["tz_offset_min"] == -360
    assert run["name"] == "Morning Run"
    assert run["distance_m"] == pytest.approx(10020)
    assert run["duration_s"] == 53 * 60 + 1
    assert run["moving_time_s"] == 51 * 60 + 50
    assert run["avg_speed_mps"] == pytest.approx(10020 / (51 * 60 + 50))
    assert run["avg_hr"] == 152
    assert run["avg_power_w"] is None  # Garmin writes 0 when there is no power meter
    assert run["raw_aerobic_te"] == "3.4"
    assert run["raw_min_elevation"] == "1,601"


def test_garmin_ride_swim_strength(garmin_metric):
    ride = by_type(garmin_metric, "ride")
    assert ride["raw_activity_type"] == "Road Cycling"
    assert ride["calories"] == 1104
    assert ride["normalized_power_w"] == 221
    assert ride["avg_power_w"] == 205
    assert by_type(garmin_metric, "swim")["distance_m"] == 1500  # pool swims export in meters
    strength = by_type(garmin_metric, "strength")
    assert strength["elevation_gain_m"] is None  # "--"


def test_garmin_imperial():
    result = parse_csv(
        fixture_bytes("garmin_activities_imperial.csv"), "g.csv",
        timezone="America/Denver", units="imperial",
    )
    run, swim = result.activities
    assert run["distance_m"] == pytest.approx(6.23 * 1609.344)
    assert run["elevation_gain_m"] == pytest.approx(279 * 0.3048)
    assert swim["distance_m"] == pytest.approx(1640 * 0.9144)


def test_garmin_without_timezone_warns_and_uses_utc():
    result = parse_csv(fixture_bytes("garmin_activities_metric.csv"), "g.csv")
    assert any("no timezone" in w for w in result.warnings)
    assert by_type(result, "run")["start_time"] == datetime(2024, 3, 10, 7, 15, 22, tzinfo=UTC)


def test_strava():
    result = parse_csv(fixture_bytes("strava_activities.csv"), "activities.csv")
    assert result.source_format == "strava_csv"
    assert len(result.activities) == 4
    assert [e.row for e in result.rejected] == [6]

    run = by_type(result, "run")
    assert run["start_time"] == datetime(2024, 3, 10, 13, 15, 30, tzinfo=UTC)
    assert run["name"] == "Morning Run"
    assert run["distance_m"] == 10020.0  # from the meters column, not the display column
    assert run["duration_s"] == 3181
    assert run["moving_time_s"] == 3110
    assert run["avg_speed_mps"] == 3.222
    assert run["avg_hr"] == 152 and run["max_hr"] == 171
    assert run["raw_filename"] == "activities/11111.fit.gz"
    assert run["raw_activity_gear"] == "Pegasus 40"

    ride = by_type(result, "ride")
    assert ride["raw_activity_type"] == "VirtualRide"
    assert ride["avg_power_w"] == 210 and ride["normalized_power_w"] == 218
    assert by_type(result, "swim")["avg_hr"] is None
    assert by_type(result, "strength")["raw_activity_type"] == "WeightTraining"


def test_unrecognized_csv():
    result = parse_csv(b"foo,bar\n1,2\n", "x.csv")
    assert result.activities == []
    assert "unrecognized CSV layout" in result.rejected[0].reason


def test_binary_csv_rejected():
    result = parse_csv(b"PK\x03\x04\x00\x00binary", "x.csv")
    assert "binary" in result.rejected[0].reason


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("Motorcycling", "other"), ("Gravel/Unpaved Cycling", "ride"), ("Treadmill Running", "run"),
     ("Hiking", "walk"), ("Yoga", "other"), ("VirtualRide", "ride")],
)
def test_activity_type_mapping(raw, expected):
    from app.parsing.schema import normalize_activity_type

    assert normalize_activity_type(raw) == expected


def test_garmin_apostrophe_prefixed_numbers():
    from app.parsing.csv_parser import _number

    assert _number("'-12") == -12
    assert _number("1,045") == 1045
