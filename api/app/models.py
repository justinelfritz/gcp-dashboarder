from datetime import date, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel
from pydantic import Field as PydanticField

MAX_SELECTED_IDS = 10_000


class HealthResponse(BaseModel):
    status: str


class SessionResponse(BaseModel):
    session_id: str


class RowIssue(BaseModel):
    row: int | None  # CSV line number; None when the whole file was rejected
    reason: str


class FileReport(BaseModel):
    filename: str
    detected_format: str | None  # fit | garmin_csv | strava_csv
    size_bytes: int
    activities_parsed: int
    activities_added: int
    duplicates_merged: int
    rows_rejected: int
    rejections: list[RowIssue]
    warnings: list[str]
    # The same bytes were processed by an earlier upload, so the file was skipped.
    already_stored: bool = False


class UploadResponse(BaseModel):
    upload_id: str
    files: list[FileReport]
    total_activities: int


MAX_CHECK_HASHES = 10_000
Sha256 = Annotated[str, PydanticField(pattern=r"^[0-9a-f]{64}$")]


class UploadCheckRequest(BaseModel):
    """SHA-256 hashes of files the browser is about to upload."""
    hashes: list[Sha256] = PydanticField(max_length=MAX_CHECK_HASHES)


class UploadCheckResponse(BaseModel):
    # Hashes already processed by this session; uploading them again would change nothing.
    known: list[str]


class ClaimRequest(BaseModel):
    # A guest session ID, shaped like the ones POST /sessions creates.
    session_id: str = PydanticField(pattern=r"^[A-Za-z0-9_-]{32}$")


class ClaimResponse(BaseModel):
    activities_added: int
    duplicates_merged: int
    total_activities: int


class LibrarySummary(BaseModel):
    activities: int  # every stored activity, including hidden types
    visible_activities: int  # outdoor runs, rides, and hikes
    # Local calendar dates of the earliest and latest stored activities.
    first_date: date | None
    last_date: date | None
    files_stored: int  # original uploaded files
    bytes_stored: int  # originals plus processed data


# ---- Activities and field catalog ----

class ActivitySummary(BaseModel):
    activity_id: str
    name: str | None
    activity_type: str
    raw_activity_type: str | None
    source_format: str
    start_time: datetime
    tz_offset_min: int | None
    distance_m: float | None
    duration_s: float | None
    moving_time_s: float | None
    avg_speed_mps: float | None
    elevation_gain_m: float | None
    avg_hr: float | None
    avg_cadence: float | None
    avg_power_w: float | None
    has_records: bool


class ActivityList(BaseModel):
    total: int
    items: list[ActivitySummary]


class FieldInfo(BaseModel):
    name: str
    label: str
    unit: str  # "cadence" means steps/min for runs and hikes, rpm for rides
    kind: Literal["number", "datetime", "category"]
    coverage: int  # activities in the selection that have data for this field


class FieldCatalog(BaseModel):
    total_activities: int
    levels: dict[str, list[FieldInfo]]


# ---- Panel queries ----

class FieldFilter(BaseModel):
    """A condition on an activity-level field."""

    field: str
    op: Literal["eq", "neq", "in", "between", "gte", "lte", "near"]
    value: Any
    # For "near": accept value * (1 ± tolerance). Defaults to the request's distance_tolerance.
    tolerance: float | None = PydanticField(default=None, ge=0, le=0.5)


class DateRange(BaseModel):
    last_days: int | None = PydanticField(default=None, ge=1)
    start: date | None = None
    end: date | None = None  # inclusive


class DisplayFilters(BaseModel):
    activity_types: list[Literal["run", "ride", "hike"]] = ["run", "ride", "hike"]
    date_range: DateRange | None = None
    filters: list[FieldFilter] = []
    # Hand-picked selection: analyze only these activities, or everything except these.
    activity_ids: list[str] | None = PydanticField(default=None, max_length=MAX_SELECTED_IDS)
    exclude_activity_ids: list[str] = PydanticField(default=[], max_length=MAX_SELECTED_IDS)


class AxisSpec(BaseModel):
    field: str
    level: Literal["activity", "lap", "record"] = "activity"
    # How lower-level rows combine into one point. Ignored for activity-level axes when each
    # point is an activity, and in "point" mode.
    agg: Literal["mean", "median", "min", "max", "sum", "count", "std"] = "mean"


class SeriesSpec(BaseModel):
    label: str = "All"
    color: str | None = None
    filters: list[FieldFilter] = []


class PanelQuery(BaseModel):
    id: str
    # What one plotted point is: an activity, a calendar bucket, or each row of the axes' level.
    group_by: Literal["activity", "week", "month", "point"] = "activity"
    lap_kind: Literal["device", "split_km", "split_mi"] = "device"
    include_partial_laps: bool = False
    x: AxisSpec = AxisSpec(field="start_time")  # ignored for week/month
    y: AxisSpec
    error: Literal["none", "std", "sem"] = "none"
    filters: list[FieldFilter] = []
    series: list[SeriesSpec] = PydanticField(default_factory=lambda: [SeriesSpec()], max_length=12)


class QueryRequest(BaseModel):
    filters: DisplayFilters = DisplayFilters()
    # 24 dashboard panels, each with an optional right-axis companion query.
    panels: list[PanelQuery] = PydanticField(max_length=48)
    distance_tolerance: float = PydanticField(default=0.025, ge=0, le=0.5)


class Point(BaseModel):
    x: float | str
    y: float
    error: float | None = None
    n: int  # rows aggregated into this point
    activity_id: str | None = None


class AxisInfo(BaseModel):
    field: str
    label: str
    unit: str
    kind: str


class SeriesResult(BaseModel):
    label: str
    color: str | None
    n_activities: int
    points: list[Point]


class PanelResult(BaseModel):
    id: str
    x: AxisInfo | None = None
    y: AxisInfo | None = None
    series: list[SeriesResult] = []
    warnings: list[str] = []
    error: str | None = None


class QueryResponse(BaseModel):
    panels: list[PanelResult]
