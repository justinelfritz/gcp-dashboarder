"""Summaries of record segments: whole-activity moving time, device laps, and computed splits.

Every segment is summarized from records with the same rules, so a device lap and a computed
split covering the same stretch report the same numbers:

- Each record owns the time and distance since the previous record.
- Moving time counts records above MOVING_SPEED_MPS, ignoring gaps over MAX_RECORD_GAP_S (pauses).
- Speed is distance / moving time. HR and power are weighted by time, since smart recording logs
  at irregular intervals. Cadence is a plain mean of all samples, zeros included: that is what
  Garmin Connect reports (exact on real run files).
- Elevation gain can't be reproduced from altitude samples (Garmin smooths barometric data its
  own way), so device laps use the watch's lap ascent and computed splits are scaled to sum to
  the watch's total ascent.
"""

from datetime import datetime

import numpy as np
import pandas as pd

# Matches Garmin Connect's "Moving Time" to the second on real run and hike files.
MOVING_SPEED_MPS = 0.3
# Longer gaps between records mean the device was paused, not moving.
MAX_RECORD_GAP_S = 30
# Ascent below this between turning points is treated as altimeter noise. Only the relative
# shape matters: split gains are rescaled to the device total.
ELEVATION_HYSTERESIS_M = 2.0
SPLIT_LENGTHS_M = {"split_km": 1000.0, "split_mi": 1609.344}
# A final split shorter than this fraction of the split length is marked partial.
PARTIAL_FRACTION = 0.99


def prepare(rows: list[dict]) -> pd.DataFrame:
    """Record rows -> DataFrame with per-record time (dt), distance (dd), and moving flag."""
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.sort_values("timestamp").reset_index(drop=True)
    for col in ("distance_m", "speed", "hr", "cadence", "power", "altitude"):
        df[col] = pd.to_numeric(df.get(col), errors="coerce").astype(float)
    df["dt"] = df["timestamp"].diff().dt.total_seconds().fillna(0.0)
    df["dd"] = df["distance_m"].diff().clip(lower=0).fillna(0.0)
    df["moving"] = (df["speed"] > MOVING_SPEED_MPS) & (df["dt"] <= MAX_RECORD_GAP_S)
    return df


def moving_time(df: pd.DataFrame, timer: float | None, active: float | None) -> float | None:
    """Seconds moving, capped at timer time. Without speed data, the device's active time."""
    if df.empty or df["speed"].isna().all():
        return active if active is not None else timer
    moving = float(df.loc[df["moving"], "dt"].sum())
    return min(moving, timer) if timer is not None else moving


def summarize(seg: pd.DataFrame) -> dict:
    distance = float(seg["dd"].sum())
    moving_s = float(seg.loc[seg["moving"], "dt"].sum())
    has_speed = seg["speed"].notna().any()
    return {
        "distance_m": distance,
        "duration_s": float(seg["dt"].sum()),
        "moving_time_s": moving_s if has_speed else None,
        "avg_speed_mps": distance / moving_s if moving_s > 0 and distance > 0 else None,
        "avg_hr": _weighted_mean(seg["hr"], seg["dt"]),
        "max_hr": float(seg["hr"].max()) if seg["hr"].notna().any() else None,
        "avg_cadence": float(seg["cadence"].mean()) if seg["cadence"].notna().any() else None,
        "avg_power_w": _weighted_mean(seg["power"], seg["dt"]),
        "elevation_gain_m": elevation_gain(seg["altitude"]),
    }


def device_laps(lap_mesgs: list[dict], df: pd.DataFrame, activity_id: str) -> list[dict]:
    """One row per device lap; each record belongs to the latest lap started at or before it."""
    starts = sorted(
        (m["start_time"], m) for m in lap_mesgs if isinstance(m.get("start_time"), datetime)
    )
    if not starts or df.empty:
        return []
    lap_starts = pd.to_datetime([s for s, _ in starts], utc=True).tz_convert(None).to_numpy()
    record_times = df["timestamp"].dt.tz_convert(None).to_numpy()
    idx = np.searchsorted(lap_starts, record_times, side="right") - 1
    rows = []
    for i, (start, mesg) in enumerate(starts):
        seg = df[idx == i] if i else df[idx <= 0]  # records before the first lap join it
        if seg.empty:
            continue
        is_last = i == len(starts) - 1
        rows.append({
            "activity_id": activity_id,
            "kind": "device",
            "lap_index": i + 1,
            "start_time": start,
            # A closing "session_end" lap after distance/manual laps is the leftover stretch.
            "is_partial": bool(is_last and len(starts) > 1
                               and mesg.get("lap_trigger") == "session_end"),
            **summarize(seg),
        })
        ascent = mesg.get("total_ascent")
        if isinstance(ascent, (int, float)):
            rows[-1]["elevation_gain_m"] = float(ascent)
    return rows


def computed_splits(
    df: pd.DataFrame, activity_id: str, device_ascent: float | None = None
) -> list[dict]:
    """Fixed-distance splits (every km and every mile) from cumulative record distance."""
    if df.empty or df["distance_m"].isna().all():
        return []
    rows = []
    for kind, length in SPLIT_LENGTHS_M.items():
        # A record covers the stretch since the previous record, so it belongs to the split
        # where that stretch began.
        began_at = df["distance_m"].ffill().fillna(0).shift(1).fillna(0)
        split_no = (began_at // length).astype(int)
        groups = list(df.groupby(split_no, sort=True))
        for n, (_, seg) in enumerate(groups):
            summary = summarize(seg)
            if summary["distance_m"] <= 0:
                continue
            is_last = n == len(groups) - 1
            rows.append({
                "activity_id": activity_id,
                "kind": kind,
                "lap_index": len([r for r in rows if r["kind"] == kind]) + 1,
                "start_time": seg["timestamp"].iloc[0],
                "is_partial": bool(is_last and summary["distance_m"] < length * PARTIAL_FRACTION),
                **summary,
            })
    if device_ascent is not None:
        for kind in SPLIT_LENGTHS_M:
            _scale_ascent([r for r in rows if r["kind"] == kind], device_ascent)
    return rows


def _scale_ascent(rows: list[dict], total: float) -> None:
    ours = sum(r["elevation_gain_m"] or 0 for r in rows)
    if ours > 0:
        for r in rows:
            if r["elevation_gain_m"] is not None:
                r["elevation_gain_m"] *= total / ours


def elevation_gain(altitude: pd.Series) -> float | None:
    """Total ascent, ignoring wiggles smaller than ELEVATION_HYSTERESIS_M."""
    alt = altitude.dropna().to_numpy()
    if alt.size < 2:
        return None
    gain, anchor = 0.0, alt[0]
    for a in alt[1:]:
        if a - anchor >= ELEVATION_HYSTERESIS_M:
            gain += a - anchor
            anchor = a
        elif a < anchor:
            anchor = a
    return gain


def _weighted_mean(values: pd.Series, weights: pd.Series) -> float | None:
    mask = values.notna() & (weights > 0)
    if not mask.any():
        mask = values.notna()  # e.g. a single sample with dt 0
        return float(values[mask].mean()) if mask.any() else None
    return float(np.average(values[mask], weights=weights[mask]))
