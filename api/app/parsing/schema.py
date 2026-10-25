"""Normalized activity and record schemas shared by all parsers.

Units are metric throughout: meters, seconds, watts, meters per second. Times are UTC.
"""

import hashlib
from dataclasses import dataclass, field
from datetime import datetime

import pandas as pd

ACTIVITY_TYPES = ("run", "ride", "swim", "strength", "walk", "other")

# Column name -> pandas dtype. Extra columns prefixed `raw_` are allowed and stored as strings.
ACTIVITY_COLUMNS: dict[str, str] = {
    "activity_id": "string",
    "source_file": "string",
    "source_format": "string",  # fit | garmin_csv | strava_csv
    "name": "string",
    "start_time": "datetime64[us, UTC]",
    "tz_offset_min": "Int32",  # local time = start_time + offset, when known
    "activity_type": "string",
    "raw_activity_type": "string",
    "duration_s": "Float64",  # elapsed time
    "moving_time_s": "Float64",
    "distance_m": "Float64",
    "elevation_gain_m": "Float64",
    "avg_hr": "Int32",
    "max_hr": "Int32",
    "avg_power_w": "Float64",
    "normalized_power_w": "Float64",
    "avg_speed_mps": "Float64",
    "calories": "Float64",
    "has_records": "boolean",
}

RECORD_COLUMNS: dict[str, str] = {
    "activity_id": "string",
    "timestamp": "datetime64[us, UTC]",
    "elapsed_s": "Float64",
    "distance_m": "Float64",
    "hr": "Int32",
    "power": "Float64",
    "cadence": "Int32",
    "speed": "Float64",
    "altitude": "Float64",
    "lat": "Float64",
    "lon": "Float64",
}

# Substring rules checked in order against the lower-cased source type, so "Trail Running",
# "VirtualRide", and FIT "running" all land in the right bucket.
_TYPE_RULES = (
    ("motor", "other"),  # before "cycl": Motorcycling is not a ride
    ("strength", "strength"),
    ("weight", "strength"),
    ("run", "run"),
    ("ride", "ride"),
    ("cycl", "ride"),
    ("bik", "ride"),
    ("swim", "swim"),
    ("walk", "walk"),
    ("hik", "walk"),
)


def normalize_activity_type(raw: str | None) -> str:
    if not raw:
        return "other"
    lowered = raw.lower().replace("_", " ")
    for needle, kind in _TYPE_RULES:
        if needle in lowered:
            return kind
    return "other"


def make_activity_id(source_format: str, start_time: datetime, activity_type: str) -> str:
    """Deterministic ID, so re-uploading the same file yields the same activity."""
    key = f"{source_format}|{start_time.isoformat()}|{activity_type}"
    return "act_" + hashlib.sha256(key.encode()).hexdigest()[:16]


@dataclass
class RowError:
    row: int | None
    reason: str


@dataclass
class ParseResult:
    source_format: str
    activities: list[dict] = field(default_factory=list)
    # activity_id -> record rows for that activity
    records: dict[str, list[dict]] = field(default_factory=dict)
    rejected: list[RowError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _coerce(df: pd.DataFrame, columns: dict[str, str]) -> None:
    for col, dtype in columns.items():
        if col not in df.columns:
            df[col] = pd.Series([None] * len(df), dtype="object")
        if dtype.startswith("datetime64"):
            df[col] = pd.to_datetime(df[col], utc=True).astype(dtype)
        else:
            df[col] = df[col].astype(dtype)


def activities_frame(rows: list[dict]) -> pd.DataFrame:
    """Build an activity DataFrame with the normalized dtypes; raw_ columns become strings."""
    df = pd.DataFrame(rows)
    _coerce(df, ACTIVITY_COLUMNS)
    raw_cols = sorted(c for c in df.columns if c.startswith("raw_") and c not in ACTIVITY_COLUMNS)
    for col in raw_cols:
        df[col] = df[col].astype("string")
    return df[list(ACTIVITY_COLUMNS) + raw_cols]


def records_frame(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    _coerce(df, RECORD_COLUMNS)
    return df[list(RECORD_COLUMNS)]
