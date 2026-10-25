"""Checks against real exports in tests/fixtures/private/ (git-ignored; skipped when absent).

Drop a Garmin Connect activities CSV and matching FIT files there. Every FIT file should match a
CSV row; these tests then check the CSV parser against the FIT values, which are always metric.
Set the CSV's timezone and units below to match the Garmin account that exported it.
"""

import os
from pathlib import Path

import pytest

from app.parsing.csv_parser import parse_csv
from app.parsing.fit_parser import parse_fit
from app.storage.session_store import merge_rows

PRIVATE = Path(__file__).parent / "fixtures" / "private"
TIMEZONE = os.environ.get("PRIVATE_FIXTURE_TZ", "America/New_York")
UNITS = os.environ.get("PRIVATE_FIXTURE_UNITS", "imperial")

csv_files = sorted(PRIVATE.glob("*.csv"))
fit_files = sorted(PRIVATE.glob("*.fit")) + sorted(PRIVATE.glob("*.fit.gz"))
pytestmark = pytest.mark.skipif(not csv_files, reason="no private fixtures")


@pytest.fixture(scope="module")
def csv_activities():
    rows = []
    for f in csv_files:
        result = parse_csv(f.read_bytes(), f.name, timezone=TIMEZONE, units=UNITS)
        assert result.rejected == [], result.rejected[:5]
        rows += result.activities
    return rows


@pytest.fixture(scope="module")
def fit_activities():
    rows = []
    for f in fit_files:
        result = parse_fit(f.read_bytes(), f.name)
        assert result.rejected == [], (f.name, result.rejected)
        assert result.warnings == [], (f.name, result.warnings)
        rows += result.activities
    return rows


def _match(fit, csv_rows):
    return next(
        (c for c in csv_rows if c["activity_type"] == fit["activity_type"]
         and abs((c["start_time"] - fit["start_time"]).total_seconds()) <= 60),
        None,
    )


def test_every_fit_file_matches_a_csv_row(csv_activities, fit_activities):
    for fit in fit_activities:
        assert _match(fit, csv_activities), f"no CSV row for {fit['source_file']}"


@pytest.mark.parametrize(
    ("field", "rel_tol", "abs_tol"),
    [
        ("distance_m", 0.005, 10),  # CSV distance is rounded to 0.01 mi/km
        ("elevation_gain_m", 0.01, 1),
        ("duration_s", 0.0, 1),
        ("moving_time_s", 0.01, 1),
        ("avg_hr", 0.0, 1),
        ("calories", 0.0, 1),
        ("tz_offset_min", 0.0, 0),
    ],
)
def test_csv_values_agree_with_fit(csv_activities, fit_activities, field, rel_tol, abs_tol):
    for fit in fit_activities:
        c = _match(fit, csv_activities)
        if fit[field] is None or c is None or c[field] is None:
            continue
        assert c[field] == pytest.approx(fit[field], rel=rel_tol, abs=abs_tol), (
            fit["source_file"], field
        )


def test_merge_collapses_fit_into_csv(csv_activities, fit_activities):
    rows, outcome = merge_rows(csv_activities, fit_activities)
    assert len(rows) == len(csv_activities)
    assert len(outcome.matched) == len(fit_activities)
