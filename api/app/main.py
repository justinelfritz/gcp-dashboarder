import logging
import secrets
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, FastAPI, File, Form, Path, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.models import HealthResponse, SessionResponse, UploadResponse
from app.parsing.csv_parser import Units
from app.storage.backends import GcsStorage, LocalStorage, Storage
from app.storage.session_store import SessionStore
from app.uploads import IncomingFile, process_upload

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dashboarder")

settings = get_settings()

# Session IDs are 32-character urlsafe tokens. Validating the shape also keeps IDs from being
# used to build storage paths outside the session's prefix.
SessionId = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{32}$")]

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
