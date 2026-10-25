"""Per-session data layout and activity merging.

sessions/{id}/raw/{sha}{ext}                    original uploads (named by content hash)
sessions/{id}/normalized/activities.parquet     one row per activity
sessions/{id}/normalized/records/{activity}.parquet   second-by-second FIT data
sessions/{id}/normalized/reports/{upload}.json  parse reports
"""

import hashlib
import io
import json
from collections import defaultdict
from dataclasses import dataclass

import pandas as pd

from app.parsing.schema import activities_frame, records_frame
from app.storage.backends import PreconditionFailed, Storage

PARQUET = "application/vnd.apache.parquet"
DUPLICATE_WINDOW_S = 60
MERGE_ATTEMPTS = 5
# When two sources describe the same activity, the higher priority one becomes the base row and
# fills its gaps from the other (so a FIT file keeps the activity name from a Strava CSV).
SOURCE_PRIORITY = {"fit": 2, "strava_csv": 1, "garmin_csv": 1}
IDENTITY_COLUMNS = {"activity_id", "source_file", "source_format"}


@dataclass
class MergeOutcome:
    added: set[str]  # activity IDs from the new batch that are now stored rows
    matched: dict[str, str]  # new activity ID -> existing ID it merged into or replaced
    total: int


class SessionStore:
    def __init__(self, storage: Storage, session_id: str) -> None:
        self.storage = storage
        self.prefix = f"sessions/{session_id}"

    def raw_file_count(self) -> int:
        return len(self.storage.list(f"{self.prefix}/raw/"))

    def save_raw(self, data: bytes, extension: str) -> str:
        path = f"{self.prefix}/raw/{hashlib.sha256(data).hexdigest()[:16]}{extension}"
        self.storage.write(path, data, "application/octet-stream")
        return path

    def load_activities(self) -> pd.DataFrame:
        found = self.storage.read(f"{self.prefix}/normalized/activities.parquet")
        if found is None:
            return activities_frame([])
        return pd.read_parquet(io.BytesIO(found[0]))

    def merge_activities(self, new_rows: list[dict]) -> MergeOutcome:
        path = f"{self.prefix}/normalized/activities.parquet"
        for _ in range(MERGE_ATTEMPTS):
            found = self.storage.read(path)
            generation = found[1] if found else 0
            existing = pd.read_parquet(io.BytesIO(found[0])).to_dict("records") if found else []
            rows, outcome = merge_rows(existing, new_rows)
            buf = io.BytesIO()
            activities_frame(rows).to_parquet(buf, index=False)
            try:
                self.storage.write(path, buf.getvalue(), PARQUET, if_generation=generation)
                return outcome
            except PreconditionFailed:
                continue  # a concurrent upload won; re-read and merge again
        raise RuntimeError("could not save activities: too many concurrent uploads")

    def save_records(self, activity_id: str, rows: list[dict]) -> None:
        buf = io.BytesIO()
        records_frame(rows).to_parquet(buf, index=False)
        path = f"{self.prefix}/normalized/records/{activity_id}.parquet"
        self.storage.write(path, buf.getvalue(), PARQUET)

    def save_report(self, upload_id: str, report: dict) -> None:
        path = f"{self.prefix}/normalized/reports/{upload_id}.json"
        self.storage.write(path, json.dumps(report).encode(), "application/json")


def merge_rows(existing: list[dict], new_rows: list[dict]) -> tuple[list[dict], MergeOutcome]:
    """Merge new activities into existing ones, collapsing duplicates.

    Two rows are the same activity when they share an activity type and start within
    DUPLICATE_WINDOW_S of each other (sources disagree by a few seconds).
    """
    rows = [dict(r) for r in existing]
    by_bucket: dict[tuple[str, int], list[int]] = defaultdict(list)

    def bucket(row) -> tuple[str, int]:
        return row["activity_type"], int(pd.Timestamp(row["start_time"]).timestamp()) // 60

    def find_match(row) -> int | None:
        kind, minute = bucket(row)
        start = pd.Timestamp(row["start_time"])
        for m in (minute - 1, minute, minute + 1):
            for i in by_bucket[(kind, m)]:
                gap = abs((pd.Timestamp(rows[i]["start_time"]) - start).total_seconds())
                if gap <= DUPLICATE_WINDOW_S:
                    return i
        return None

    for i, row in enumerate(rows):
        by_bucket[bucket(row)].append(i)

    added: set[str] = set()
    matched: dict[str, str] = {}
    for new in new_rows:
        i = find_match(new)
        if i is None:
            rows.append(dict(new))
            by_bucket[bucket(new)].append(len(rows) - 1)
            added.add(new["activity_id"])
            continue
        old = rows[i]
        matched[new["activity_id"]] = old["activity_id"]
        new_wins = SOURCE_PRIORITY.get(new["source_format"], 0) > SOURCE_PRIORITY.get(
            old["source_format"], 0
        )
        base, other = (dict(new), old) if new_wins else (old, new)
        for col, value in other.items():
            if col not in IDENTITY_COLUMNS and _is_missing(base.get(col)) and not _is_missing(value):
                base[col] = value
        rows[i] = base
        if new_wins:
            added.add(new["activity_id"])
    return rows, MergeOutcome(added=added, matched=matched, total=len(rows))


def _is_missing(value) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False
