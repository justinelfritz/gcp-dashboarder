import logging
import secrets
from datetime import date
from functools import lru_cache
from typing import Annotated, Literal

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, Path, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import (
    ActivityList,
    ActivitySummary,
    DateRange,
    DisplayFilters,
    FieldCatalog,
    HealthResponse,
    QueryRequest,
    QueryResponse,
    SessionResponse,
    UploadResponse,
)
from app.parsing.csv_parser import Units
from app.parsing.schema import VISIBLE_TYPES
from app.query import engine
from app.storage.backends import GcsStorage, LocalStorage, Storage
from app.storage.session_store import SessionStore
from app.uploads import IncomingFile, process_upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dashboarder")

settings = get_settings()

# Session IDs are 32-character urlsafe tokens. Validating the shape also keeps IDs from being
# used to build storage paths outside the session's prefix.
SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{32}$")]
ActivityTypes = Annotated[list[Literal["run", "ride", "hike"]] | None, Query()]

app = FastAPI(title="Dashboarder API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


@lru_cache
def get_storage() -> Storage:
    if settings.session_bucket:
        return GcsStorage(settings.session_bucket)
    return LocalStorage(settings.local_storage_dir)


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/sessions", response_model=SessionResponse, status_code=201)
def create_session() -> SessionResponse:
    # Unguessable ID: it is the only thing protecting a session's data in v1.
    session_id = secrets.token_urlsafe(24)
    logger.info("session created session_id=%s", session_id)
    return SessionResponse(session_id=session_id)


@app.post("/sessions/{session_id}/uploads", response_model=UploadResponse)
def upload_files(
    session_id: SessionId,
    files: Annotated[list[UploadFile], File(description="FIT, FIT.gz, or CSV files")],
    storage: Annotated[Storage, Depends(get_storage)],
    timezone: Annotated[
        str | None, Form(description="IANA timezone for Garmin CSV local times")
    ] = None,
    units: Annotated[Units, Form(description="Unit system of Garmin CSV values")] = "metric",
) -> UploadResponse:
    incoming = []
    for f in files:
        # Read one byte past the limit so oversized files are detected without reading them fully.
        data = f.file.read(settings.max_file_bytes + 1)
        too_large = len(data) > settings.max_file_bytes
        incoming.append(IncomingFile(f.filename or "upload", b"" if too_large else data, too_large))
    return process_upload(
        SessionStore(storage, session_id),
        incoming,
        timezone=timezone,
        units=units,
        max_file_bytes=settings.max_file_bytes,
        max_files_per_session=settings.max_files_per_session,
        session_id=session_id,
    )


@app.get("/sessions/{session_id}/activities", response_model=ActivityList)
def list_activities(
    session_id: SessionId,
    storage: Annotated[Storage, Depends(get_storage)],
    activity_type: ActivityTypes = None,
    start: date | None = None,
    end: date | None = None,
    last_days: Annotated[int | None, Query(ge=1)] = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ActivityList:
    """Visible activities (runs, rides, hikes), newest first.

    Dates filter the same way as a query's `date_range`: local dates, inclusive.
    """
    acts = engine.visible_activities(SessionStore(storage, session_id).load_activities())
    date_range = DateRange(last_days=last_days, start=start, end=end)
    acts = engine.apply_display_filters(
        acts,
        DisplayFilters(activity_types=activity_type or list(VISIBLE_TYPES), date_range=date_range),
        tolerance=0,
    )
    acts = acts.sort_values("start_time", ascending=False)
    page = acts.iloc[offset: offset + limit]
    fields = ActivitySummary.model_fields
    items = [
        ActivitySummary(**{k: (None if _is_na(v) else v) for k, v in row.items() if k in fields})
        for row in page.to_dict("records")
    ]
    return ActivityList(total=len(acts), items=items)


@app.get("/sessions/{session_id}/fields", response_model=FieldCatalog)
def list_fields(
    session_id: SessionId,
    storage: Annotated[Storage, Depends(get_storage)],
    activity_type: ActivityTypes = None,
) -> FieldCatalog:
    return engine.field_catalog(
        SessionStore(storage, session_id), list(activity_type or VISIBLE_TYPES)
    )


@app.post("/sessions/{session_id}/query", response_model=QueryResponse)
def query(
    session_id: SessionId,
    request: QueryRequest,
    storage: Annotated[Storage, Depends(get_storage)],
) -> QueryResponse:
    """Data for a batch of panels, so the frontend fetches a whole display in one request."""
    return engine.run_query(SessionStore(storage, session_id), request)


def _is_na(value) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False
