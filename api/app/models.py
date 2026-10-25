from pydantic import BaseModel


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


class UploadResponse(BaseModel):
    upload_id: str
    files: list[FileReport]
    total_activities: int
