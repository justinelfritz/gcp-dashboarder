import logging
import secrets
from datetime import date
from functools import lru_cache
from typing import Annotated, Literal

import pandas as pd
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    Response,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.auth import AccountDeleter, current_user, get_account_deleter
from app.config import get_settings
from app.models import (
    ActivityList,
    ActivitySummary,
    ClaimRequest,
    ClaimResponse,
    DashboardsDocument,
    DateRange,
    DeleteResponse,
    DisplayFilters,
    FieldCatalog,
    HealthResponse,
    LibrarySummary,
    QueryRequest,
    QueryResponse,
    SaveDashboardsRequest,
    SaveDashboardsResponse,
    SessionResponse,
    UploadCheckRequest,
    UploadCheckResponse,
    UploadResponse,
)
from app.parsing.csv_parser import Units
from app.parsing.schema import VISIBLE_TYPES
from app.query import engine
from app.storage.backends import GcsStorage, LocalStorage, PreconditionFailed, Storage
from app.storage.data_store import DataStore
from app.uploads import IncomingFile, is_known, process_upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dashboarder")

settings = get_settings()

# Session IDs are 32-character urlsafe tokens. Validating the shape also keeps IDs from being
# used to build storage paths outside the session's prefix.
SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{32}$")]
ActivityTypes = Annotated[list[Literal["run", "ride", "hike"]] | None, Query()]
ActivityId = Annotated[str, Path(pattern=r"^act_[0-9a-f]{16}$")]
DASHBOARDS = "dashboards.json"

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


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/sessions", response_model=SessionResponse, status_code=201)
def create_session() -> SessionResponse:
    # Unguessable ID: it is the only thing protecting a session's data in v1.
    session_id = secrets.token_urlsafe(24)
    logger.info("session created session_id=%s", session_id)
    return SessionResponse(session_id=session_id)


def session_store(
    session_id: SessionId, storage: Annotated[Storage, Depends(get_storage)]
) -> DataStore:
    """A guest session's data: anyone holding the unguessable ID can use it."""
    return DataStore.for_session(storage, session_id, settings.max_files_per_session)


def user_store(
    uid: Annotated[str, Depends(current_user)], storage: Annotated[Storage, Depends(get_storage)]
) -> DataStore:
    """The signed-in user's data, located by the UID from their verified token only."""
    return DataStore.for_user(storage, uid, settings.max_files_per_user)


def data_routes(get_store) -> APIRouter:
    """Upload and query routes, the same for a guest session and a signed-in user."""
    router = APIRouter()
    Store = Annotated[DataStore, Depends(get_store)]

    @router.post("/uploads", response_model=UploadResponse)
    def upload_files(
        store: Store,
        files: Annotated[list[UploadFile], File(description="FIT, FIT.gz, or CSV files")],
        timezone: Annotated[
            str | None, Form(description="IANA timezone for Garmin CSV local times")
        ] = None,
        units: Annotated[Units, Form(description="Unit system of Garmin CSV values")] = "metric",
    ) -> UploadResponse:
        incoming = []
        for f in files:
            # Read one byte past the limit so oversized files are detected without reading them.
            data = f.file.read(settings.max_file_bytes + 1)
            too_large = len(data) > settings.max_file_bytes
            incoming.append(
                IncomingFile(f.filename or "upload", b"" if too_large else data, too_large)
            )
        return process_upload(
            store, incoming, timezone=timezone, units=units, max_file_bytes=settings.max_file_bytes
        )

    @router.post("/uploads/check", response_model=UploadCheckResponse)
    def check_uploads(store: Store, body: UploadCheckRequest) -> UploadCheckResponse:
        """Which of these FIT file hashes are already processed.

        The browser hashes files before uploading and sends only the unknown ones, so
        re-uploading a full export costs only the new files.
        """
        seen = store.manifest()
        known = [h for h in dict.fromkeys(body.hashes) if is_known(seen.get(h))]
        logger.info("upload check %s hashes=%d known=%d", store.label, len(body.hashes), len(known))
        return UploadCheckResponse(known=known)

    @router.get("/library", response_model=LibrarySummary)
    def library(store: Store) -> LibrarySummary:
        """What is stored: activity counts, date span, and storage used."""
        acts = store.load_activities()
        visible = engine.visible_activities(acts)
        days = engine.local_start(acts.dropna(subset=["start_time"])).dt.date
        _, bytes_stored = store.usage()
        return LibrarySummary(
            activities=len(acts),
            visible_activities=len(visible),
            first_date=days.min() if len(days) else None,
            last_date=days.max() if len(days) else None,
            files_stored=store.raw_file_count(),
            bytes_stored=bytes_stored,
        )

    @router.get("/activities", response_model=ActivityList)
    def list_activities(
        store: Store,
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
        acts = engine.visible_activities(store.load_activities())
        date_range = DateRange(last_days=last_days, start=start, end=end)
        acts = engine.apply_display_filters(
            acts,
            DisplayFilters(
                activity_types=activity_type or list(VISIBLE_TYPES), date_range=date_range
            ),
            tolerance=0,
        )
        acts = acts.sort_values("start_time", ascending=False)
        page = acts.iloc[offset: offset + limit]
        fields = ActivitySummary.model_fields
        items = [
            ActivitySummary(
                **{k: (None if _is_na(v) else v) for k, v in row.items() if k in fields}
            )
            for row in page.to_dict("records")
        ]
        return ActivityList(total=len(acts), items=items)

    @router.delete("/activities/{activity_id}", status_code=204)
    def delete_activity(store: Store, activity_id: ActivityId) -> Response:
        """Delete one activity, its laps and records, and its original file if nothing else uses
        it. Uploading that file again brings the activity back."""
        if not store.delete_activity(activity_id):
            raise HTTPException(404, "no such activity")
        logger.info("deleted activity %s activity_id=%s", store.label, activity_id)
        return Response(status_code=204)

    @router.get("/fields", response_model=FieldCatalog)
    def list_fields(store: Store, activity_type: ActivityTypes = None) -> FieldCatalog:
        return engine.field_catalog(store, list(activity_type or VISIBLE_TYPES))

    @router.post("/query", response_model=QueryResponse)
    def query(store: Store, request: QueryRequest) -> QueryResponse:
        """Data for a batch of panels, so the frontend fetches a whole display in one request."""
        return engine.run_query(store, request)

    return router


app.include_router(data_routes(session_store), prefix="/sessions/{session_id}", tags=["guest"])
app.include_router(data_routes(user_store), prefix="/me", tags=["signed in"])


@app.delete("/sessions/{session_id}", response_model=DeleteResponse)
def delete_session(store: Annotated[DataStore, Depends(session_store)]) -> DeleteResponse:
    """Delete everything a guest session has stored."""
    count = store.delete_all()
    logger.info("deleted all data %s objects=%d", store.label, count)
    return DeleteResponse(objects_deleted=count)


@app.delete("/me", response_model=DeleteResponse)
def delete_me(
    uid: Annotated[str, Depends(current_user)],
    store: Annotated[DataStore, Depends(user_store)],
    delete_account: Annotated[AccountDeleter, Depends(get_account_deleter)],
) -> DeleteResponse:
    """Delete everything the user has stored, then the account itself.

    Data goes first: if deleting the account then fails, nothing is left behind under it.
    """
    count = store.delete_all()
    delete_account(uid)
    logger.info("deleted account and all data %s objects=%d", store.label, count)
    return DeleteResponse(objects_deleted=count)


@app.get("/me/dashboards", response_model=DashboardsDocument)
def get_dashboards(store: Annotated[DataStore, Depends(user_store)]) -> DashboardsDocument:
    """The user's dashboards and settings, as last saved from any device."""
    document, generation = store.read_document(DASHBOARDS)
    return DashboardsDocument(document=document, generation=generation)


@app.put("/me/dashboards", response_model=SaveDashboardsResponse,
         responses={409: {"model": DashboardsDocument}})
def save_dashboards(
    body: SaveDashboardsRequest, store: Annotated[DataStore, Depends(user_store)]
):
    """Save dashboards and settings. Refused (409, with the current copy) if another device
    saved since `base_generation`, so one device never silently overwrites another's changes."""
    try:
        generation = store.write_document(DASHBOARDS, body.document, body.base_generation)
    except ValueError as exc:
        raise HTTPException(413, str(exc)) from exc
    except PreconditionFailed:
        document, current = store.read_document(DASHBOARDS)
        return JSONResponse(
            status_code=409,
            content=DashboardsDocument(document=document, generation=current).model_dump(),
        )
    return SaveDashboardsResponse(generation=generation)


@app.post("/me/claim-session", response_model=ClaimResponse)
def claim_session(
    body: ClaimRequest,
    user: Annotated[DataStore, Depends(user_store)],
    storage: Annotated[Storage, Depends(get_storage)],
) -> ClaimResponse:
    """Move a guest session's activities into the signed-in user's data.

    Called after sign-in so files uploaded as a guest aren't lost. Duplicates of activities the
    user already has are merged, as in an upload.
    """
    guest = DataStore.for_session(storage, body.session_id, settings.max_files_per_session)
    outcome = user.copy_from(guest)
    if outcome is None:
        raise HTTPException(404, "that session has no stored activities")
    added = len(outcome.added - set(outcome.matched))
    logger.info("claimed %s into %s added=%d merged=%d",
                guest.label, user.label, added, len(outcome.matched))
    return ClaimResponse(
        activities_added=added, duplicates_merged=len(outcome.matched),
        total_activities=outcome.total,
    )


def _is_na(value) -> bool:
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False
