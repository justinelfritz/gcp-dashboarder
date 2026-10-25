"""Parse Garmin Connect and Strava activity CSV exports into normalized activities.

Garmin Connect ("Activities > Export CSV"): one row per activity, local start times with no
timezone, and values in the account's display units with no unit labels. The caller supplies the
timezone and unit system.

Strava bulk export (`activities.csv`): start times in UTC. Some column names appear twice; the
second copy of Distance is in meters, which pandas exposes as "Distance.1".
"""

import io
import re
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

import pandas as pd

from app.parsing.schema import (
    ParseResult,
    RowError,
    make_activity_id,
    normalize_activity_type,
)

Units = Literal["metric", "imperial"]

M_PER_MI = 1609.344
M_PER_FT = 0.3048
M_PER_YD = 0.9144
MISSING = {"", "--", "n/a", "na", "null", "none"}

# Source columns each profile maps to normalized fields; the rest are kept as raw_ columns.
GARMIN_MAPPED = frozenset({
    "Activity Type", "Date", "Title", "Distance", "Calories", "Time", "Moving Time",
    "Elapsed Time", "Avg HR", "Max HR", "Total Ascent", "Avg Power",
})
STRAVA_MAPPED = frozenset({
    "Activity Date", "Activity Name", "Activity Type", "Elapsed Time", "Elapsed Time.1",
    "Moving Time", "Distance", "Distance.1", "Max Heart Rate", "Max Heart Rate.1",
    "Average Heart Rate", "Average Speed", "Elevation Gain", "Average Watts",
    "Weighted Average Power", "Calories",
})
STRAVA_DATE_FORMAT = "%b %d, %Y, %I:%M:%S %p"


class CsvFormatError(ValueError):
    pass


def detect_csv_format(header: list[str]) -> str | None:
    cols = set(header)
    if {"Activity ID", "Activity Date", "Activity Type"} <= cols:
        return "strava_csv"
    if {"Activity Type", "Date"} <= cols and cols & {"Time", "Elapsed Time"}:
        return "garmin_csv"
    return None


def decode_text(data: bytes) -> str:
    """Decode CSV bytes, rejecting binary content that only claims to be CSV."""
    if b"\x00" in data[:8192]:
        raise CsvFormatError("file is binary, not CSV")
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise CsvFormatError("file is not valid UTF-8 or Windows-1252 text")


def parse_csv(
    data: bytes,
    source_file: str,
    timezone: str | None = None,
    units: Units = "metric",
) -> ParseResult:
    try:
        text = decode_text(data)
        df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, skipinitialspace=True)
    except (CsvFormatError, pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
        result = ParseResult(source_format="csv")
        result.rejected.append(RowError(None, f"could not read CSV: {exc}"))
        return result

    fmt = detect_csv_format(list(df.columns))
    if fmt is None:
        result = ParseResult(source_format="csv")
        result.rejected.append(
            RowError(None, "unrecognized CSV layout; expected a Garmin Connect or Strava export")
        )
        return result
    if fmt == "garmin_csv":
        return _parse_garmin(df, source_file, timezone, units)
    return _parse_strava(df, source_file)


def _parse_garmin(df: pd.DataFrame, source_file: str, timezone: str | None, units: Units):
    result = ParseResult(source_format="garmin_csv")
    tz = _resolve_timezone(timezone, result)
    result.warnings.append(
        f"Garmin CSV has no unit labels; values were read as {units}. "
        "If that's wrong, re-upload with the other unit setting."
    )
    dist_unit, swim_unit, elev_unit = (
        (1000.0, 1.0, 1.0) if units == "metric" else (M_PER_MI, M_PER_YD, M_PER_FT)
    )
    np_cols = [c for c in df.columns if c.startswith("Normalized Power")]

    for idx, row in df.iterrows():
        line = int(idx) + 2  # header is line 1
        try:
            local = _parse_datetime(row["Date"], ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"))
            start = local.replace(tzinfo=tz)
            raw_type = _text(row.get("Activity Type"))
            activity_type = normalize_activity_type(raw_type)

            distance = _number(row.get("Distance"))
            if distance is not None:
                # Pool swims are exported in meters/yards; everything else in km/miles.
                if activity_type == "swim" and distance > 50:
                    distance *= swim_unit
                else:
                    distance *= dist_unit
            ascent = _number(row.get("Total Ascent"))
            timer = _duration(row.get("Time"))
            moving = _duration(row.get("Moving Time")) or timer
            elapsed = _duration(row.get("Elapsed Time")) or timer

            activity = _base(source_file, "garmin_csv", start, activity_type, raw_type, row)
            activity.update(
                tz_offset_min=_offset_min(start),
                distance_m=distance,
                duration_s=elapsed,
                moving_time_s=moving,
                elevation_gain_m=ascent * elev_unit if ascent is not None else None,
                avg_hr=_int(row.get("Avg HR")),
                max_hr=_int(row.get("Max HR")),
                avg_power_w=_positive(row.get("Avg Power")),
                normalized_power_w=_positive(row.get(np_cols[0])) if np_cols else None,
                calories=_number(row.get("Calories")),
                avg_speed_mps=_speed(distance, moving or elapsed),
            )
            activity.update(_raw_columns(row, GARMIN_MAPPED | set(np_cols)))
            result.activities.append(activity)
        except (ValueError, KeyError) as exc:
            result.rejected.append(RowError(line, str(exc)))
    return result


def _parse_strava(df: pd.DataFrame, source_file: str):
    result = ParseResult(source_format="strava_csv")
    has_meters = "Distance.1" in df.columns
    if not has_meters:
        result.warnings.append(
            "no distance-in-meters column found; using the display Distance column as kilometers"
        )

    for idx, row in df.iterrows():
        line = int(idx) + 2
        try:
            start = _parse_datetime(row["Activity Date"], (STRAVA_DATE_FORMAT,)).replace(
                tzinfo=ZoneInfo("UTC")
            )
            raw_type = _text(row.get("Activity Type"))
            activity_type = normalize_activity_type(raw_type)
            if has_meters:
                distance = _number(row.get("Distance.1"))
            else:
                km = _number(row.get("Distance"))
                distance = km * 1000 if km is not None else None
            elapsed = _number(row.get("Elapsed Time"))
            moving = _number(row.get("Moving Time"))

            activity = _base(source_file, "strava_csv", start, activity_type, raw_type, row)
            activity.update(
                name=_text(row.get("Activity Name")),
                distance_m=distance,
                duration_s=elapsed,
                moving_time_s=moving,
                elevation_gain_m=_number(row.get("Elevation Gain")),
                avg_hr=_int(row.get("Average Heart Rate")),
                max_hr=_int(row.get("Max Heart Rate")),
                avg_power_w=_positive(row.get("Average Watts")),
                normalized_power_w=_positive(row.get("Weighted Average Power")),
                calories=_number(row.get("Calories")),
                avg_speed_mps=_number(row.get("Average Speed")) or _speed(
                    distance, moving or elapsed
                ),
            )
            activity.update(_raw_columns(row, STRAVA_MAPPED))
            result.activities.append(activity)
        except (ValueError, KeyError) as exc:
            result.rejected.append(RowError(line, str(exc)))
    return result


def _base(source_file, source_format, start, activity_type, raw_type, row) -> dict:
    return {
        "activity_id": make_activity_id(source_format, start, activity_type),
        "source_file": source_file,
        "source_format": source_format,
        "name": _text(row.get("Title")),
        "start_time": start,
        "tz_offset_min": None,
        "activity_type": activity_type,
        "raw_activity_type": raw_type,
        "has_records": False,
    }


def _resolve_timezone(name: str | None, result: ParseResult) -> ZoneInfo:
    if name:
        try:
            return ZoneInfo(name)
        except (KeyError, ValueError):
            result.warnings.append(f"unknown timezone {name!r}; local times were read as UTC")
            return ZoneInfo("UTC")
    result.warnings.append("no timezone given; Garmin local times were read as UTC")
    return ZoneInfo("UTC")


def _offset_min(dt: datetime) -> int | None:
    offset = dt.utcoffset()
    return int(offset.total_seconds() // 60) if offset is not None else None


def _parse_datetime(value: str, formats: tuple[str, ...]) -> datetime:
    value = (value or "").strip()
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
    raise ValueError(f"unrecognized date {value!r}")


def _text(value) -> str | None:
    if value is None:
        return None
    value = str(value).strip()
    # Garmin writes some negatives as "'-12" so spreadsheets don't read them as formulas.
    if value.startswith("'") and value[1:2] in ("-", "+", "="):
        value = value[1:]
    return None if value.lower() in MISSING else value


def _number(value) -> float | None:
    text = _text(value)
    if text is None:
        return None
    try:
        return float(text.replace(",", ""))
    except ValueError:
        raise ValueError(f"not a number: {text!r}") from None


def _positive(value) -> float | None:
    """Garmin and Strava write 0 when a sensor was absent; treat that as missing."""
    n = _number(value)
    return n if n else None


def _int(value) -> int | None:
    n = _positive(value)
    return round(n) if n is not None else None


def _duration(value) -> float | None:
    """Parse "HH:MM:SS", "MM:SS(.f)", or plain seconds."""
    text = _text(value)
    if text is None:
        return None
    parts = text.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        raise ValueError(f"not a duration: {text!r}") from None
    seconds = 0.0
    for n in nums:
        seconds = seconds * 60 + n
    return seconds


def _speed(distance_m: float | None, seconds: float | None) -> float | None:
    if distance_m and seconds:
        return distance_m / seconds
    return None


def _snake(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _raw_columns(row: pd.Series, mapped: set[str]) -> dict:
    out = {}
    for col, value in row.items():
        if col in mapped or _text(value) is None:
            continue
        out[f"raw_{_snake(str(col))}"] = str(value).strip()
    return out
