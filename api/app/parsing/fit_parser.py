"""Parse Garmin FIT activity files (plain or gzipped) into normalized activities and records."""

import zlib
from datetime import UTC, datetime, timedelta
from itertools import pairwise

from garmin_fit_sdk import Decoder, Stream

from app.parsing.schema import (
    ParseResult,
    RowError,
    make_activity_id,
    normalize_activity_type,
)

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)
GZIP_MAGIC = b"\x1f\x8b"
MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024
SEMICIRCLE_TO_DEG = 180 / 2**31
# Matches Garmin Connect's "Moving Time" to the second on real run and hike files.
MOVING_SPEED_MPS = 0.3
# Longer gaps between records mean the device was paused, not moving.
MAX_RECORD_GAP_S = 30

# FIT session field -> normalized column
SESSION_FIELDS = {
    "total_elapsed_time": "duration_s",
    "total_distance": "distance_m",
    "total_ascent": "elevation_gain_m",
    "avg_heart_rate": "avg_hr",
    "max_heart_rate": "max_hr",
    "avg_power": "avg_power_w",
    "normalized_power": "normalized_power_w",
    "total_calories": "calories",
}
# Fields consumed elsewhere or with no analytical value; not kept as raw_ columns.
SESSION_SKIP = {
    "timestamp", "start_time", "sport", "sub_sport", "avg_speed", "enhanced_avg_speed",
    "message_index", "event", "event_type", "trigger", "first_lap_index", "num_laps",
}


def is_fit(data: bytes) -> bool:
    return len(data) >= 12 and data[8:12] == b".FIT"


def is_gzip(data: bytes) -> bool:
    return data[:2] == GZIP_MAGIC


def gunzip_capped(data: bytes, limit: int = MAX_DECOMPRESSED_BYTES) -> bytes:
    """Decompress gzip data, refusing output larger than `limit` (zip-bomb guard)."""
    d = zlib.decompressobj(wbits=31)
    out = d.decompress(data, limit + 1)
    if len(out) > limit or d.unconsumed_tail:
        raise ValueError(f"decompressed file exceeds {limit // (1024 * 1024)} MB")
    return out


def parse_fit(data: bytes, source_file: str) -> ParseResult:
    result = ParseResult(source_format="fit")
    if is_gzip(data):
        try:
            data = gunzip_capped(data)
        except (ValueError, zlib.error) as exc:
            result.rejected.append(RowError(None, f"could not decompress: {exc}"))
            return result
    if not is_fit(data):
        result.rejected.append(RowError(None, "not a FIT file"))
        return result

    messages, errors = Decoder(Stream.from_byte_array(bytearray(data))).read()
    if errors:
        # The SDK returns whatever it decoded before the error, so keep going if possible.
        result.warnings.append(f"file is damaged or truncated: {errors[0]}")

    sessions = messages.get("session_mesgs", [])
    records = messages.get("record_mesgs", [])
    offset_min = _tz_offset_min(messages.get("activity_mesgs", []))

    if not sessions:
        if not records:
            result.rejected.append(RowError(None, "no session or record data in file"))
            return result
        result.warnings.append("no session summary in file; summary derived from records")
        sessions = [_session_from_records(records, messages.get("sport_mesgs", []))]

    for i, session in enumerate(sessions):
        start = session.get("start_time")
        if not isinstance(start, datetime):
            result.rejected.append(RowError(i, "session has no start time"))
            continue
        activity = _activity_from_session(session, source_file, offset_min)
        end = start + timedelta(seconds=activity.get("duration_s") or 0)
        # Multisport files hold several sessions; give each one the records in its time window.
        in_window = records if len(sessions) == 1 else [
            r for r in records if start <= r.get("timestamp", start) <= end
        ]
        rows = [_record_row(r, activity["activity_id"], start) for r in in_window]
        rows = [r for r in rows if r is not None]
        activity["has_records"] = bool(rows)
        activity["moving_time_s"] = _moving_time(
            rows, _num(session.get("total_timer_time")), _num(session.get("active_time"))
        )
        if rows:
            result.records[activity["activity_id"]] = rows
        result.activities.append(activity)
    return result


def _activity_from_session(session: dict, source_file: str, offset_min: int | None) -> dict:
    sport = str(session.get("sport", "generic"))
    sub_sport = str(session.get("sub_sport", "generic"))
    activity_type = normalize_activity_type(f"{sub_sport} {sport}")
    start = session["start_time"]

    activity = {
        "activity_id": make_activity_id("fit", start, activity_type),
        "source_file": source_file,
        "source_format": "fit",
        "start_time": start,
        "tz_offset_min": offset_min,
        "activity_type": activity_type,
        "raw_activity_type": sport if sub_sport == "generic" else f"{sport}/{sub_sport}",
        "avg_speed_mps": _num(session.get("enhanced_avg_speed", session.get("avg_speed"))),
    }
    for fit_name, col in SESSION_FIELDS.items():
        activity[col] = _num(session.get(fit_name))
    for key, value in session.items():
        # Unknown/developer fields come back with integer keys; skip them.
        if not isinstance(key, str) or key in SESSION_FIELDS or key in SESSION_SKIP:
            continue
        if isinstance(value, datetime):
            value = value.isoformat()
        if isinstance(value, (int, float, str)):
            activity[f"raw_{key}"] = str(value)
    return activity


def _session_from_records(records: list[dict], sport_mesgs: list[dict]) -> dict:
    timed = [r for r in records if isinstance(r.get("timestamp"), datetime)]
    if not timed:
        return {}
    start, end = timed[0]["timestamp"], timed[-1]["timestamp"]
    hrs = [r["heart_rate"] for r in timed if isinstance(r.get("heart_rate"), (int, float))]
    dists = [r["distance"] for r in timed if isinstance(r.get("distance"), (int, float))]
    sport = sport_mesgs[0] if sport_mesgs else {}
    return {
        "start_time": start,
        "sport": sport.get("sport", "generic"),
        "sub_sport": sport.get("sub_sport", "generic"),
        "total_elapsed_time": (end - start).total_seconds(),
        "total_distance": max(dists) if dists else None,
        "avg_heart_rate": round(sum(hrs) / len(hrs)) if hrs else None,
        "max_heart_rate": max(hrs) if hrs else None,
    }


def _record_row(r: dict, activity_id: str, start: datetime) -> dict | None:
    ts = r.get("timestamp")
    if not isinstance(ts, datetime):
        return None
    lat, lon = _num(r.get("position_lat")), _num(r.get("position_long"))
    return {
        "activity_id": activity_id,
        "timestamp": ts,
        "elapsed_s": (ts - start).total_seconds(),
        "distance_m": _num(r.get("distance")),
        "hr": _num(r.get("heart_rate")),
        "power": _num(r.get("power")),
        "cadence": _num(r.get("cadence")),
        "speed": _num(r.get("enhanced_speed", r.get("speed"))),
        "altitude": _num(r.get("enhanced_altitude", r.get("altitude"))),
        "lat": lat * SEMICIRCLE_TO_DEG if lat is not None else None,
        "lon": lon * SEMICIRCLE_TO_DEG if lon is not None else None,
    }


def _tz_offset_min(activity_mesgs: list[dict]) -> int | None:
    """UTC offset from the activity message's local_timestamp, rounded to 15 minutes."""
    for a in activity_mesgs:
        local, ts = a.get("local_timestamp"), a.get("timestamp")
        if isinstance(local, int) and isinstance(ts, datetime):
            utc_seconds = (ts - FIT_EPOCH).total_seconds()
            offset = round((local - utc_seconds) / 900) * 15
            if -14 * 60 <= offset <= 14 * 60:
                return offset
    return None


def _moving_time(rows: list[dict], timer: float | None, active: float | None) -> float | None:
    """Seconds spent above walking-still speed, capped at timer time.

    Activities without speed data (strength, yoga) use the device's active time if it wrote one.
    """
    moving, has_speed = 0.0, False
    for prev, cur in pairwise(rows):
        if cur["speed"] is None:
            continue
        has_speed = True
        gap = (cur["timestamp"] - prev["timestamp"]).total_seconds()
        if cur["speed"] > MOVING_SPEED_MPS and gap <= MAX_RECORD_GAP_S:
            moving += gap
    if not has_speed:
        return active if active is not None else timer
    return min(moving, timer) if timer is not None else moving


def _num(value) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value
