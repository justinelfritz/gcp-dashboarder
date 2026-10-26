"""Parse Garmin FIT activity files (plain or gzipped) into activities, records, and laps."""

import zlib
from datetime import UTC, datetime, timedelta

from garmin_fit_sdk import Decoder, Stream

from app.parsing import segments
from app.parsing.schema import (
    FOOT_TYPES,
    ParseResult,
    RowError,
    is_indoor_type,
    make_activity_id,
    normalize_activity_type,
)

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=UTC)
GZIP_MAGIC = b"\x1f\x8b"
MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024
SEMICIRCLE_TO_DEG = 180 / 2**31
RECORD_DATA_FIELDS = ("hr", "power", "cadence", "speed", "altitude", "lat")

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
    "avg_cadence", "avg_fractional_cadence",
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

    laps = messages.get("lap_mesgs", [])
    for i, session in enumerate(sessions):
        start = session.get("start_time")
        if not isinstance(start, datetime):
            result.rejected.append(RowError(i, "session has no start time"))
            continue
        activity = _activity_from_session(session, source_file, offset_min)
        end = start + timedelta(seconds=activity.get("duration_s") or 0)
        multi = len(sessions) > 1
        foot = activity["activity_type"] in FOOT_TYPES
        rows = [_record_row(r, activity["activity_id"], start, foot)
                for r in _in_window(records, "timestamp", start, end, multi)]
        rows = [r for r in rows if r is not None]
        df = segments.prepare(rows)
        activity["has_records"] = bool(rows)
        activity["record_fields"] = ",".join(
            f for f in RECORD_DATA_FIELDS if rows and df[f].notna().any()
        ) if rows else None
        activity["moving_time_s"] = segments.moving_time(
            df, _num(session.get("total_timer_time")), _num(session.get("active_time"))
        )
        if rows:
            aid = activity["activity_id"]
            result.records[aid] = rows
            lap_rows = segments.device_laps(
                _in_window(laps, "start_time", start, end, multi), df, aid
            )
            lap_rows += segments.computed_splits(df, aid, activity["elevation_gain_m"])
            if lap_rows:
                result.laps[aid] = lap_rows
        result.activities.append(activity)
    return result


def _in_window(mesgs: list[dict], key: str, start, end, multi: bool) -> list[dict]:
    """Multisport files hold several sessions; each gets the messages in its time window."""
    if not multi:
        return mesgs
    return [m for m in mesgs if start <= m.get(key, start) <= end]


def _activity_from_session(session: dict, source_file: str, offset_min: int | None) -> dict:
    sport = str(session.get("sport", "generic"))
    sub_sport = str(session.get("sub_sport", "generic"))
    activity_type = normalize_activity_type(f"{sub_sport} {sport}")
    raw_type = sport if sub_sport == "generic" else f"{sport}/{sub_sport}"
    start = session["start_time"]

    activity = {
        "activity_id": make_activity_id("fit", start, activity_type),
        "source_file": source_file,
        "source_format": "fit",
        "start_time": start,
        "tz_offset_min": offset_min,
        "activity_type": activity_type,
        "raw_activity_type": raw_type,
        "is_indoor": is_indoor_type(raw_type),
        "avg_speed_mps": _num(session.get("enhanced_avg_speed", session.get("avg_speed"))),
        "avg_cadence": _cadence(
            session.get("avg_cadence"), session.get("avg_fractional_cadence"),
            activity_type in FOOT_TYPES,
        ),
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


def _record_row(r: dict, activity_id: str, start: datetime, foot: bool) -> dict | None:
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
        "cadence": _cadence(r.get("cadence"), r.get("fractional_cadence"), foot),
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


def _cadence(whole, fraction, foot: bool) -> float | None:
    """FIT stores run/walk cadence per leg; report steps per minute (both legs)."""
    whole = _num(whole)
    if whole is None:
        return None
    total = whole + (_num(fraction) or 0)
    return total * 2 if foot else total


def _num(value) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value
