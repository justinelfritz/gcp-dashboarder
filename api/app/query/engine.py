"""Run panel queries: filter activities, compute each axis at its level, aggregate into points.

A panel's `group_by` sets what one point is:
- activity: one point per activity. Lower-level axes (lap, record) aggregate that activity's rows
  with the axis' `agg`, and the y error bar is the spread (std or sem) of those rows.
- week / month: one point per calendar bucket of the activity's local start (weeks start Monday).
  Rows from every activity in the bucket aggregate together.
- point: one point per row of the axes' level, e.g. every lap's pace against its heart rate.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pandas as pd

from app.models import (
    AxisInfo,
    AxisSpec,
    DisplayFilters,
    FieldCatalog,
    FieldFilter,
    FieldInfo,
    PanelQuery,
    PanelResult,
    Point,
    QueryRequest,
    QueryResponse,
    SeriesResult,
)
from app.parsing.schema import VISIBLE_TYPES
from app.parsing.segments import MOVING_SPEED_MPS
from app.query import catalog
from app.storage.data_store import DataStore

MAX_POINTS_PER_SERIES = 5000
LEVEL_RANK = {"activity": 0, "lap": 1, "record": 2}


class QueryError(ValueError):
    """A problem with a panel definition, reported on that panel."""


@dataclass
class Context:
    store: DataStore
    activities: pd.DataFrame
    tolerance: float
    record_columns: set[str]
    _laps: pd.DataFrame | None = field(default=None, repr=False)
    _records: pd.DataFrame | None = field(default=None, repr=False)

    def laps(self) -> pd.DataFrame:
        if self._laps is None:
            self._laps = self.store.load_laps()
        return self._laps

    def records(self) -> pd.DataFrame:
        # Loaded once per request for every panel's needs, only for activities that have records.
        if self._records is None:
            ids = self.activities.loc[self.activities["has_records"].fillna(False), "activity_id"]
            self._records = self.store.load_records(ids, sorted(self.record_columns))
        return self._records


def run_query(store: DataStore, req: QueryRequest, now: datetime | None = None) -> QueryResponse:
    activities = visible_activities(store.load_activities())
    try:
        activities = apply_display_filters(activities, req.filters, req.distance_tolerance, now)
    except QueryError as exc:
        return QueryResponse(panels=[PanelResult(id=p.id, error=str(exc)) for p in req.panels])

    record_columns: set[str] = set()
    for panel in req.panels:
        for axis in (panel.x, panel.y):
            if axis.level == "record" and axis.field in catalog.CATALOG["record"]:
                record_columns |= catalog.record_columns(catalog.get_field("record", axis.field))
    ctx = Context(store, activities, req.distance_tolerance, record_columns)
    return QueryResponse(panels=[run_panel(panel, ctx) for panel in req.panels])


def visible_activities(df: pd.DataFrame) -> pd.DataFrame:
    """Activities the app analyzes: runs, rides, and hikes, outdoors."""
    keep = df["activity_type"].isin(VISIBLE_TYPES) & ~df["is_indoor"].fillna(False).astype(bool)
    return df[keep].reset_index(drop=True)


def local_start(df: pd.DataFrame) -> pd.Series:
    offset = pd.to_timedelta(df["tz_offset_min"].fillna(0).astype(int), unit="min")
    return (df["start_time"] + offset).dt.tz_localize(None)


def apply_display_filters(
    df: pd.DataFrame, filters: DisplayFilters, tolerance: float, now: datetime | None = None
) -> pd.DataFrame:
    df = df[df["activity_type"].isin(filters.activity_types)]
    if filters.date_range:
        dr = filters.date_range
        if dr.last_days:
            cutoff = (now or datetime.now(UTC)) - timedelta(days=dr.last_days)
            df = df[df["start_time"] >= cutoff]
        local_day = local_start(df).dt.date
        if dr.start:
            df = df[local_day >= dr.start]
            local_day = local_day[df.index]
        if dr.end:
            df = df[local_day <= dr.end]
    if filters.activity_ids is not None:
        df = df[df["activity_id"].isin(filters.activity_ids)]
    if filters.exclude_activity_ids:
        df = df[~df["activity_id"].isin(filters.exclude_activity_ids)]
    return apply_filters(df, filters.filters, tolerance)


def apply_filters(df: pd.DataFrame, filters: list[FieldFilter], tolerance: float) -> pd.DataFrame:
    for flt in filters:
        try:
            f = catalog.get_field("activity", flt.field)
        except KeyError as exc:
            raise QueryError(f"cannot filter: {exc.args[0]}") from None
        vals = catalog.values(df, f)
        value = flt.value
        if f.kind == "datetime":
            value = _to_timestamps(value)
        try:
            mask = _filter_mask(vals, flt.op, value, flt.tolerance, tolerance)
        except (TypeError, ValueError):
            raise QueryError(f"bad value for {flt.op!r} filter on {flt.field}: {flt.value!r}") from None
        df = df[mask.fillna(False).astype(bool)]
    return df


def _filter_mask(vals: pd.Series, op: str, value, own_tol, default_tol) -> pd.Series:
    match op:
        case "eq":
            return vals == value
        case "neq":
            return vals != value
        case "in":
            if not isinstance(value, list):
                raise TypeError("'in' needs a list")
            return vals.isin(value)
        case "between":
            lo, hi = value
            return (vals >= lo) & (vals <= hi)
        case "gte":
            return vals >= value
        case "lte":
            return vals <= value
        case "near":
            tol = own_tol if own_tol is not None else default_tol
            target = float(value)
            return (vals >= target * (1 - tol)) & (vals <= target * (1 + tol))
    raise ValueError(op)


def _to_timestamps(value):
    if isinstance(value, list):
        return [pd.Timestamp(v, tz=UTC) if pd.Timestamp(v).tzinfo is None else pd.Timestamp(v)
                for v in value]
    ts = pd.Timestamp(value)
    return ts.tz_localize(UTC) if ts.tzinfo is None else ts


# ---- Panels ----

def run_panel(panel: PanelQuery, ctx: Context) -> PanelResult:
    try:
        x_field, y_field = _validate(panel)
        result = PanelResult(id=panel.id, x=_x_info(panel, x_field), y=_axis_info(y_field))
        if panel.error != "none" and panel.y.level == "activity" and panel.group_by == "activity":
            result.warnings.append(
                "error bars need lap or record data on the y axis, or weekly/monthly grouping"
            )
        for series in panel.series:
            acts = apply_filters(ctx.activities, panel.filters + series.filters, ctx.tolerance)
            points, contributing = _points(panel, ctx, acts)
            if (total := len(points)) > MAX_POINTS_PER_SERIES:
                step = -(-total // MAX_POINTS_PER_SERIES)
                points = points.iloc[::step]
                prefix = f"{series.label}: " if len(panel.series) > 1 else ""
                result.warnings.append(
                    f"{prefix}showing {len(points)} of {total} points (every {step})"
                )
            missing = len(acts) - contributing
            if missing > 0 and len(acts):
                prefix = f"{series.label}: " if len(panel.series) > 1 else ""
                needed = y_field.label.lower()
                if panel.group_by not in ("week", "month") and x_field.name != "start_time":
                    needed += f" or {x_field.label.lower()}"
                result.warnings.append(
                    f"{prefix}{missing} of {len(acts)} activities have no {needed} data"
                )
            result.series.append(SeriesResult(
                label=series.label,
                color=series.color,
                n_activities=len(acts),
                points=_to_points(points, x_is_time=_x_is_time(panel, x_field)),
            ))
        return result
    except QueryError as exc:
        return PanelResult(id=panel.id, error=str(exc))


def _validate(panel: PanelQuery) -> tuple[catalog.Field, catalog.Field]:
    fields = []
    for name, axis in (("x", panel.x), ("y", panel.y)):
        try:
            f = catalog.get_field(axis.level, axis.field)
        except KeyError as exc:
            raise QueryError(f"{name} axis: {exc.args[0]}") from None
        if f.kind == "category":
            raise QueryError(f"{name} axis: {f.label} can be filtered on but not plotted")
        fields.append(f)
    x_field, y_field = fields
    if y_field.kind != "number":
        raise QueryError(f"y axis: {y_field.label} is not a number")
    if panel.group_by in ("activity",) and x_field.kind == "datetime" and panel.x.level != "activity":
        raise QueryError("x axis: lap and record times can only be plotted with group_by 'point'")
    if panel.group_by == "point":
        lower = {a.level for a in (panel.x, panel.y)} - {"activity"}
        if len(lower) > 1:
            raise QueryError("point mode needs both axes at the same level (or one at activity)")
    return x_field, y_field


def _points(panel: PanelQuery, ctx: Context, acts: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """DataFrame of x, y, error, n, activity_id sorted by x; and how many activities contributed."""
    if acts.empty:
        return pd.DataFrame(columns=["x", "y", "error", "n", "activity_id"]), 0
    if panel.group_by == "point":
        return _point_rows(panel, ctx, acts)
    if panel.group_by in ("week", "month"):
        return _bucket_points(panel, ctx, acts)
    return _activity_points(panel, ctx, acts)


def _axis_rows(axis: AxisSpec, panel: PanelQuery, ctx: Context, acts: pd.DataFrame) -> pd.DataFrame:
    """One row per row of the axis' level: activity_id and the field's value."""
    f = catalog.get_field(axis.level, axis.field)
    frame = _level_frame(axis.level, panel, ctx, acts)
    vals = catalog.values(frame, f)
    if f.moving_only:
        vals = vals.where(frame["speed"].astype(float) > MOVING_SPEED_MPS)
    if f.kind == "datetime":
        # Plot times as the activity's local wall-clock time, as the watch and Garmin show it.
        offsets = frame["activity_id"].map(acts.set_index("activity_id")["tz_offset_min"])
        vals = (vals + pd.to_timedelta(offsets.fillna(0).astype(int), unit="min")).dt.tz_localize(None)
    return pd.DataFrame({"activity_id": frame["activity_id"].to_numpy(), "value": vals.to_numpy()},
                        index=frame.index)


def _level_frame(level: str, panel: PanelQuery, ctx: Context, acts: pd.DataFrame) -> pd.DataFrame:
    ids = acts["activity_id"]
    if level == "activity":
        return acts
    if level == "lap":
        laps = ctx.laps()
        laps = laps[(laps["kind"] == panel.lap_kind) & laps["activity_id"].isin(ids)]
        if not panel.include_partial_laps:
            laps = laps[~laps["is_partial"].fillna(False).astype(bool)]
        return laps
    records = ctx.records()
    return records[records["activity_id"].isin(ids)]


def _aggregate(rows: pd.DataFrame, key: str, agg: str, error: str) -> pd.DataFrame:
    rows = rows.dropna(subset=["value"])
    g = rows.groupby(key)["value"]
    out = pd.DataFrame({"value": g.agg(agg), "n": g.count()})
    if error == "std":
        out["error"] = g.std()
    elif error == "sem":
        out["error"] = g.sem()
    else:
        out["error"] = float("nan")
    return out


def _activity_points(panel, ctx, acts):
    y_rows = _axis_rows(panel.y, panel, ctx, acts)
    if panel.y.level == "activity":
        y = y_rows.set_index("activity_id").rename(columns={"value": "y"})
        y["n"], y["error"] = 1, float("nan")
    else:
        y = _aggregate(y_rows, "activity_id", panel.y.agg, panel.error).rename(columns={"value": "y"})
    x_rows = _axis_rows(panel.x, panel, ctx, acts)
    if panel.x.level == "activity":
        x = x_rows.set_index("activity_id")["value"].rename("x")
    else:
        x = _aggregate(x_rows, "activity_id", panel.x.agg, "none")["value"].rename("x")
    pts = y.join(x, how="inner").dropna(subset=["x", "y"]).reset_index(names="activity_id")
    return pts.sort_values("x"), pts["activity_id"].nunique()


def _bucket_points(panel, ctx, acts):
    starts = local_start(acts)
    if panel.group_by == "week":
        buckets = (starts.dt.normalize() - pd.to_timedelta(starts.dt.day_of_week, unit="D"))
    else:
        buckets = starts.dt.to_period("M").dt.start_time
    bucket_of = pd.Series(buckets.dt.strftime("%Y-%m-%d").to_numpy(), index=acts["activity_id"])
    rows = _axis_rows(panel.y, panel, ctx, acts)
    rows["bucket"] = rows["activity_id"].map(bucket_of)
    contributing = rows.dropna(subset=["value"])["activity_id"].nunique()
    agg = _aggregate(rows, "bucket", panel.y.agg, panel.error)
    pts = agg.rename(columns={"value": "y"}).reset_index(names="x")
    pts["activity_id"] = None
    return pts.sort_values("x"), contributing


def _point_rows(panel, ctx, acts):
    level = max((panel.x.level, panel.y.level), key=LEVEL_RANK.__getitem__)
    frame = _level_frame(level, panel, ctx, acts)

    def column(axis):
        rows = _axis_rows(axis, panel, ctx, acts)
        if axis.level == level:
            return rows["value"]
        # An activity-level field repeated on every lap/record of that activity.
        return frame["activity_id"].map(rows.set_index("activity_id")["value"])

    pts = pd.DataFrame({"activity_id": frame["activity_id"], "x": column(panel.x),
                        "y": column(panel.y), "n": 1, "error": float("nan")})
    pts = pts.dropna(subset=["x", "y"])
    return pts.sort_values(["x"]), pts["activity_id"].nunique()


# ---- Output ----

def _x_is_time(panel: PanelQuery, x_field: catalog.Field) -> bool:
    return panel.group_by in ("week", "month") or x_field.kind == "datetime"


def _to_points(df: pd.DataFrame, x_is_time: bool) -> list[Point]:
    points = []
    for row in df.itertuples(index=False):
        x = row.x
        if x_is_time:
            x = x if isinstance(x, str) else pd.Timestamp(x).isoformat()
        else:
            x = float(x)
        error = None if pd.isna(row.error) else float(row.error)
        aid = row.activity_id if isinstance(row.activity_id, str) else None
        points.append(Point(x=x, y=float(row.y), error=error, n=int(row.n), activity_id=aid))
    return points


def _axis_info(f: catalog.Field) -> AxisInfo:
    return AxisInfo(field=f.name, label=f.label, unit=f.unit, kind=f.kind)


def _x_info(panel: PanelQuery, x_field: catalog.Field) -> AxisInfo:
    if panel.group_by == "week":
        return AxisInfo(field="week", label="Week", unit="date", kind="datetime")
    if panel.group_by == "month":
        return AxisInfo(field="month", label="Month", unit="date", kind="datetime")
    return _axis_info(x_field)


# ---- Field catalog ----

def field_catalog(store: DataStore, activity_types: list[str]) -> FieldCatalog:
    """Every plottable field per level, with how many selected activities have data for it."""
    acts = visible_activities(store.load_activities())
    acts = acts[acts["activity_type"].isin(activity_types)]
    ids = set(acts["activity_id"])
    laps = store.load_laps()
    laps = laps[laps["activity_id"].isin(ids)]
    record_fields = acts["record_fields"].fillna("").str.split(",")

    levels: dict[str, list[FieldInfo]] = {}
    for level, fields in catalog.CATALOG.items():
        infos = []
        for f in fields.values():
            if level == "activity":
                coverage = int(catalog.values(acts, f).notna().sum())
            elif level == "lap":
                has = catalog.values(laps, f).notna()
                coverage = laps.loc[has, "activity_id"].nunique()
            else:
                coverage = int(record_fields.apply(lambda fs, src=f.record_source: src in fs).sum())
            infos.append(FieldInfo(name=f.name, label=f.label, unit=f.unit, kind=f.kind,
                                   coverage=coverage))
        levels[level] = infos
    return FieldCatalog(total_activities=len(acts), levels=levels)
