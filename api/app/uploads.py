"""Upload pipeline: validate each file, parse it, merge activities, and build parse reports."""

import logging
import secrets
from dataclasses import dataclass

from app.models import FileReport, RowIssue, UploadResponse
from app.parsing.csv_parser import Units, parse_csv
from app.parsing.fit_parser import is_fit, is_gzip, parse_fit
from app.parsing.schema import ParseResult, RowError
from app.storage.session_store import SessionStore

logger = logging.getLogger("dashboarder.uploads")

ALLOWED_EXTENSIONS = (".fit.gz", ".fit", ".csv")
MAX_REPORTED_REJECTIONS = 50


@dataclass
class IncomingFile:
    filename: str
    data: bytes
    too_large: bool = False


def _extension(filename: str) -> str | None:
    lowered = filename.lower()
    return next((ext for ext in ALLOWED_EXTENSIONS if lowered.endswith(ext)), None)


def _parse_one(f: IncomingFile, timezone: str | None, units: Units) -> ParseResult:
    ext = _extension(f.filename)
    if ext is None:
        return _rejected(f"unsupported file type; upload {', '.join(ALLOWED_EXTENSIONS)} files")
    if ext in (".fit", ".fit.gz"):
        # Check content, not just the name: a FIT file starts with a header containing ".FIT".
        if not (is_fit(f.data) or (ext == ".fit.gz" and is_gzip(f.data))):
            return _rejected("file content is not FIT data")
        return parse_fit(f.data, f.filename)
    return parse_csv(f.data, f.filename, timezone=timezone, units=units)


def _rejected(reason: str) -> ParseResult:
    result = ParseResult(source_format="unknown")
    result.rejected.append(RowError(None, reason))
    return result


def process_upload(
    store: SessionStore,
    files: list[IncomingFile],
    *,
    timezone: str | None,
    units: Units,
    max_file_bytes: int,
    max_files_per_session: int,
    session_id: str,
) -> UploadResponse:
    upload_id = "up_" + secrets.token_hex(8)
    slots = max_files_per_session - store.raw_file_count()

    parsed: list[tuple[IncomingFile, ParseResult]] = []
    for f in files:
        if f.too_large:
            result = _rejected(f"file exceeds {max_file_bytes // (1024 * 1024)} MB limit")
        elif slots <= 0:
            result = _rejected(f"session already has the maximum of {max_files_per_session} files")
        else:
            result = _parse_one(f, timezone, units)
            if result.activities:
                store.save_raw(f.data, _extension(f.filename) or "")
                slots -= 1
        parsed.append((f, result))

    all_rows = [a for _, r in parsed for a in r.activities]
    outcome = store.merge_activities(all_rows) if all_rows else None

    reports = []
    for f, result in parsed:
        for activity_id, rows in result.records.items():
            if outcome and activity_id in outcome.added:
                store.save_records(activity_id, rows)
        ids = [a["activity_id"] for a in result.activities]
        added = sum(1 for i in ids if outcome and i in outcome.added and i not in outcome.matched)
        report = FileReport(
            filename=f.filename,
            detected_format=None if result.source_format == "unknown" else result.source_format,
            size_bytes=len(f.data),
            activities_parsed=len(ids),
            activities_added=added,
            duplicates_merged=sum(1 for i in ids if outcome and i in outcome.matched),
            rows_rejected=len(result.rejected),
            rejections=[RowIssue(row=e.row, reason=e.reason) for e in result.rejected][
                :MAX_REPORTED_REJECTIONS
            ],
            warnings=result.warnings,
        )
        reports.append(report)
        # Never log file contents or names; sizes and counts only.
        logger.info(
            "parsed file session_id=%s upload_id=%s size=%d format=%s parsed=%d added=%d "
            "rejected=%d",
            session_id, upload_id, report.size_bytes, report.detected_format,
            report.activities_parsed, report.activities_added, report.rows_rejected,
        )

    total = outcome.total if outcome else len(store.load_activities())
    response = UploadResponse(upload_id=upload_id, files=reports, total_activities=total)
    store.save_report(upload_id, response.model_dump())
    return response
