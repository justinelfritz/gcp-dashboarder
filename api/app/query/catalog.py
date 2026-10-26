"""Fields a panel can plot, per level of detail.

Levels, coarse to fine: activity (one row per activity), lap (device laps or computed splits),
record (per-sample data). Units are metric; the frontend converts for display. Cadence is steps
per minute for runs and hikes and rpm for rides.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import numpy as np
import pandas as pd

from app.parsing.segments import MOVING_SPEED_MPS

Level = Literal["activity", "lap", "record"]
LEVELS: tuple[Level, ...] = ("activity", "lap", "record")
Kind = Literal["number", "datetime", "category"]


@dataclass(frozen=True)
class Field:
    name: str
    label: str
    unit: str
    kind: Kind = "number"
    # Computed from other columns of the level's frame; otherwise read from column `name`.
    derive: Callable[[pd.DataFrame], pd.Series] | None = None
    # Record level only: aggregate over moving samples, so stops don't drag speed toward zero
    # or blow pace up toward infinity.
    moving_only: bool = False
    # Record column whose presence means this field has data (for coverage counts).
    record_source: str | None = None


def _pace_from_time(df: pd.DataFrame) -> pd.Series:
    seconds = df["moving_time_s"].fillna(df["duration_s"])
    return (seconds / df["distance_m"] * 1000).where(df["distance_m"] > 0)


def _pace_from_speed(column: str) -> Callable[[pd.DataFrame], pd.Series]:
    def derive(df: pd.DataFrame) -> pd.Series:
        speed = df[column].astype(float)
        return (1000 / speed).where(speed > MOVING_SPEED_MPS)
    return derive



ACTIVITY_FIELDS = [
    Field("start_time", "Date", "datetime", kind="datetime"),
    Field("activity_type", "Activity type", "", kind="category"),
    Field("distance_m", "Distance", "m"),
    Field("duration_s", "Elapsed time", "s"),
    Field("moving_time_s", "Moving time", "s"),
    Field("avg_speed_mps", "Average speed", "m/s"),
    Field("avg_pace_s_per_km", "Average pace", "s/km", derive=_pace_from_time),
    Field("elevation_gain_m", "Elevation gain", "m"),
    Field("avg_hr", "Average heart rate", "bpm"),
    Field("max_hr", "Max heart rate", "bpm"),
    Field("avg_cadence", "Average cadence", "cadence"),
    Field("avg_power_w", "Average power", "W"),
    Field("normalized_power_w", "Normalized power", "W"),
    Field("calories", "Calories", "kcal"),
]

LAP_FIELDS = [
    Field("lap_index", "Lap number", ""),
    Field("start_time", "Lap start", "datetime", kind="datetime"),
    Field("distance_m", "Lap distance", "m"),
    Field("duration_s", "Lap elapsed time", "s"),
    Field("moving_time_s", "Lap moving time", "s"),
    Field("avg_speed_mps", "Lap speed", "m/s"),
    Field("avg_pace_s_per_km", "Lap pace", "s/km", derive=_pace_from_speed("avg_speed_mps")),
    Field("avg_hr", "Lap heart rate", "bpm"),
    Field("max_hr", "Lap max heart rate", "bpm"),
    Field("avg_cadence", "Lap cadence", "cadence"),
    Field("avg_power_w", "Lap power", "W"),
    Field("elevation_gain_m", "Lap elevation gain", "m"),
]

RECORD_FIELDS = [
    Field("elapsed_s", "Time into activity", "s", record_source="speed"),
    Field("distance_m", "Distance into activity", "m", record_source="speed"),
    Field("speed", "Speed", "m/s", moving_only=True, record_source="speed"),
    Field("pace_s_per_km", "Pace", "s/km", moving_only=True,
          derive=_pace_from_speed("speed"), record_source="speed"),
    Field("hr", "Heart rate", "bpm", record_source="hr"),
    Field("cadence", "Cadence", "cadence", record_source="cadence"),
    Field("power", "Power", "W", record_source="power"),
    Field("altitude", "Altitude", "m", record_source="altitude"),
]

CATALOG: dict[Level, dict[str, Field]] = {
    "activity": {f.name: f for f in ACTIVITY_FIELDS},
    "lap": {f.name: f for f in LAP_FIELDS},
    "record": {f.name: f for f in RECORD_FIELDS},
}


def get_field(level: Level, name: str) -> Field:
    try:
        return CATALOG[level][name]
    except KeyError:
        raise KeyError(f"unknown {level} field {name!r}") from None


def values(df: pd.DataFrame, f: Field) -> pd.Series:
    """The field's values for each row of a level frame."""
    if f.derive is not None:
        return f.derive(df)
    series = df[f.name]
    if f.kind == "number":
        return pd.to_numeric(series, errors="coerce").astype(float).replace([np.inf, -np.inf], np.nan)
    return series


def record_columns(f: Field) -> set[str]:
    """Raw record columns needed to compute a record-level field."""
    cols = {"speed"} if f.moving_only else set()
    if f.derive is not None:
        cols.add("speed")
    else:
        cols.add(f.name)
    return cols
