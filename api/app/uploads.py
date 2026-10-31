"""Upload pipeline: validate each file, parse it, merge activities, and build parse reports."""

import logging
import secrets
from dataclasses import dataclass

from app.models import FileReport, RowIssue, UploadResponse
from app.parsing.csv_parser import Units, parse_csv
from app.parsing.fit_parser import is_fit, is_gzip, parse_fit
from app.parsing.schema import ParseResult, RowError
from app.storage.data_store import DataStore, content_hash

logger = logging.getLogger("dashboarder.uploads")

ALLOWED_EXTENSIONS = (".fit.gz", ".fit", ".csv")
# Bump when the FIT parser changes what it accepts, so files it rejected get another try.
FIT_PARSER_VERSION = 1
REJECTED = f"rejected@{FIT_PARSER_VERSION}"


def is_known(outcome: str | None) -> bool:
    """True when a FIT file with this manifest outcome needs no re-processing."""
    return outcome in ("stored", REJECTED)
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
    store: DataStore,
    files: list[IncomingFile],
    *,
    timezone: str | None,
    units: Units,
    max_file_bytes: int,
) -> UploadResponse:
    upload_id = "up_" + secrets.token_hex(8)
    slots = store.max_files - store.raw_file_count()
    seen = store.manifest()
    outcomes: dict[str, str] = {}

    parsed: list[tuple[IncomingFile, ParseResult]] = []
    known: set[int] = set()
    for i, f in enumerate(files):
        # Only FIT files are skipped by content: a CSV's meaning depends on the units and timezone
        # chosen at upload, so re-uploading one with other settings must re-parse it.
        is_fit_file = _extension(f.filename) in (".fit", ".fit.gz")
        digest = content_hash(f.data) if is_fit_file and not f.too_large else None
        if digest and (is_known(seen.get(digest)) or digest in outcomes):
            known.add(i)
            result = ParseResult(source_format="fit")
        elif f.too_large:
            result = _rejected(f"file exceeds {max_file_bytes // (1024 * 1024)} MB limit")
        elif slots <= 0:
            result = _rejected(f"storage already holds the maximum of {store.max_files} files")
        else:
            result = _parse_one(f, timezone, units)
            if result.activities:
                store.save_raw(f.data, _extension(f.filename) or "")
                slots -= 1
            if digest:
                outcomes[digest] = "stored" if result.activities else REJECTED
        parsed.append((f, result))

    all_rows = [a for _, r in parsed for a in r.activities]
    outcome = store.merge_activities(all_rows) if all_rows else None

    # Only activities whose row came from this upload get their detail data saved; a duplicate
    # of an activity already stored keeps the stored version's records and laps.
    winners = outcome.added if outcome else set()
    store.save_laps({
        aid: rows for _, r in parsed for aid, rows in r.laps.items() if aid in winners
    })
    reports = []
    for i, (f, result) in enumerate(parsed):
        for activity_id, rows in result.records.items():
            if activity_id in winners:
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
            already_stored=i in known,
        )
        reports.append(report)
        # Never log file contents or names; sizes and counts only.
        logger.info(
            "parsed file %s upload_id=%s size=%d format=%s parsed=%d added=%d rejected=%d",
            store.label, upload_id, report.size_bytes, report.detected_format,
            report.activities_parsed, report.activities_added, report.rows_rejected,
        )

    # Record outcomes only after the activities, laps, and records are saved, so a failed upload
    # is retried in full rather than skipped.
    store.record_files(outcomes)
    total = outcome.total if outcome else len(store.load_activities())
    response = UploadResponse(upload_id=upload_id, files=reports, total_activities=total)
    store.save_report(upload_id, response.model_dump())
    return response
