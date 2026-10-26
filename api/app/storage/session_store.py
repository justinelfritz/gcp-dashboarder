"""Per-session data layout and activity merging.

sessions/{id}/raw/{sha}{ext}                    original uploads (named by content hash)
sessions/{id}/normalized/activities.parquet     one row per activity
sessions/{id}/normalized/laps.parquet           device laps and computed splits
sessions/{id}/normalized/records/{activity}.parquet   second-by-second FIT data
sessions/{id}/normalized/reports/{upload}.json  parse reports
"""

import hashlib
import io
import json
from collections import defaultdict
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import pandas as pd

from app.parsing.schema import activities_frame, laps_frame, records_frame
from app.storage.backends import PreconditionFailed, Storage

PARQUET = "application/vnd.apache.parquet"
DUPLICATE_WINDOW_S = 60
MERGE_ATTEMPTS = 5
RECORD_READ_THREADS = 16
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

    def _path(self, name: str) -> str:
        return f"{self.prefix}/normalized/{name}"

    def _read_parquet(self, name: str, empty: Callable[[], pd.DataFrame]) -> pd.DataFrame:
        found = self.storage.read(self._path(name))
        return pd.read_parquet(io.BytesIO(found[0])) if found else empty()

    def _update_parquet(self, name: str, update: Callable[[list[dict]], list[dict]],
                        frame: Callable[[list[dict]], pd.DataFrame]) -> None:
        """Read-modify-write with a generation precondition, retrying if another upload wins."""
        path = self._path(name)
        for _ in range(MERGE_ATTEMPTS):
            found = self.storage.read(path)
            generation = found[1] if found else 0
            existing = pd.read_parquet(io.BytesIO(found[0])).to_dict("records") if found else []
            buf = io.BytesIO()
            frame(update(existing)).to_parquet(buf, index=False)
            try:
                self.storage.write(path, buf.getvalue(), PARQUET, if_generation=generation)
                return
            except PreconditionFailed:
                continue
        raise RuntimeError(f"could not save {name}: too many concurrent uploads")

    def load_activities(self) -> pd.DataFrame:
        return self._read_parquet("activities.parquet", lambda: activities_frame([]))

    def load_laps(self) -> pd.DataFrame:
        return self._read_parquet("laps.parquet", lambda: laps_frame([]))

    def load_records(self, activity_ids: Iterable[str], columns: list[str]) -> pd.DataFrame:
        """Records for the given activities, read in parallel; missing files are skipped."""
        cols = sorted({"activity_id", *columns})

        def read_one(aid: str) -> pd.DataFrame | None:
            found = self.storage.read(self._path(f"records/{aid}.parquet"))
            return pd.read_parquet(io.BytesIO(found[0]), columns=cols) if found else None

        with ThreadPoolExecutor(RECORD_READ_THREADS) as pool:
            frames = [f for f in pool.map(read_one, list(activity_ids)) if f is not None]
        return pd.concat(frames, ignore_index=True) if frames else records_frame([])[cols]

    def merge_activities(self, new_rows: list[dict]) -> MergeOutcome:
        result: list[MergeOutcome] = []

        def update(existing: list[dict]) -> list[dict]:
            rows, outcome = merge_rows(existing, new_rows)
            result[:] = [outcome]
            return rows

        self._update_parquet("activities.parquet", update, activities_frame)
        return result[0]

    def save_laps(self, laps_by_activity: dict[str, list[dict]]) -> None:
        """Replace the laps of the given activities."""
        if not laps_by_activity:
            return

        def update(existing: list[dict]) -> list[dict]:
            kept = [r for r in existing if r["activity_id"] not in laps_by_activity]
            return kept + [r for rows in laps_by_activity.values() for r in rows]

        self._update_parquet("laps.parquet", update, laps_frame)

    def save_records(self, activity_id: str, rows: list[dict]) -> None:
        buf = io.BytesIO()
        records_frame(rows).to_parquet(buf, index=False)
        self.storage.write(self._path(f"records/{activity_id}.parquet"), buf.getvalue(), PARQUET)

    def save_report(self, upload_id: str, report: dict) -> None:
        self.storage.write(
            self._path(f"reports/{upload_id}.json"), json.dumps(report).encode(), "application/json"
        )


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
