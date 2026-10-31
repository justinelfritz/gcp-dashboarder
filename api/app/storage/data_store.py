"""Stored activity data and activity merging, for one owner: a guest session or a user.

Every owner's data lives under its prefix, `sessions/{id}` (guests, deleted after a few days) or
`users/{uid}` (signed-in users, kept until deleted):

{prefix}/raw/{sha256}{ext}                 original uploads (named by content hash)
{prefix}/manifest.json                     sha256 -> outcome for every FIT file seen
{prefix}/normalized/activities.parquet     one row per activity
{prefix}/normalized/laps.parquet           device laps and computed splits
{prefix}/normalized/records/{activity}.parquet   second-by-second FIT data
{prefix}/normalized/reports/{upload}.json  parse reports
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


class DataStore:
    def __init__(self, storage: Storage, prefix: str, *, max_files: int, label: str) -> None:
        self.storage = storage
        self.prefix = prefix
        # Most original files this owner may store.
        self.max_files = max_files
        # Identifies the owner in logs ("session=…" or "user=…"); never an email or file name.
        self.label = label

    @classmethod
    def for_session(cls, storage: Storage, session_id: str, max_files: int) -> "DataStore":
        return cls(storage, f"sessions/{session_id}", max_files=max_files,
                   label=f"session={session_id}")

    @classmethod
    def for_user(cls, storage: Storage, uid: str, max_files: int) -> "DataStore":
        return cls(storage, f"users/{uid}", max_files=max_files, label=f"user={uid}")

    def raw_file_count(self) -> int:
        return len(self.storage.list(f"{self.prefix}/raw/"))

    def usage(self) -> tuple[int, int]:
        """Objects and bytes stored for this owner, raw and normalized."""
        return self.storage.usage(f"{self.prefix}/")

    def save_raw(self, data: bytes, extension: str) -> str:
        path = f"{self.prefix}/raw/{content_hash(data)}{extension}"
        self.storage.write(path, data, "application/octet-stream")
        return path

    def manifest(self) -> dict[str, str]:
        """Content hash -> outcome ("stored" or "rejected@<parser version>") per FIT file processed."""
        found = self.storage.read(f"{self.prefix}/manifest.json")
        return json.loads(found[0]) if found else {}

    def record_files(self, outcomes: dict[str, str]) -> None:
        """Add processed files to the manifest, so a later upload of the same bytes is skipped."""
        if not outcomes:
            return
        path = f"{self.prefix}/manifest.json"
        for _ in range(MERGE_ATTEMPTS):
            found = self.storage.read(path)
            manifest = json.loads(found[0]) if found else {}
            manifest.update(outcomes)
            try:
                self.storage.write(path, json.dumps(manifest).encode(), "application/json",
                                   if_generation=found[1] if found else 0)
                return
            except PreconditionFailed:
                continue
        raise RuntimeError("could not save the file manifest: too many concurrent uploads")

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

    def copy_from(self, other: "DataStore") -> MergeOutcome | None:
        """Merge another owner's activities into this one, e.g. a guest session claimed at sign-in.

        Duplicates collapse exactly as in an upload. Laps and records come along for activities
        whose row wins the merge, and original files up to this owner's file limit. The other
        owner's data is left in place.
        """
        rows = other.load_activities().to_dict("records")
        if not rows:
            return None
        outcome = self.merge_activities(rows)
        winners = outcome.added
        laps = other.load_laps()
        self.save_laps({
            aid: group.to_dict("records")
            for aid, group in laps.groupby("activity_id") if aid in winners
        })
        for aid in winners:
            found = self.storage.read(other._path(f"records/{aid}.parquet"))
            if found:
                self.storage.write(self._path(f"records/{aid}.parquet"), found[0], PARQUET)
        have = {path.rsplit("/", 1)[1] for path in self.storage.list(f"{self.prefix}/raw/")}
        slots = self.max_files - len(have)
        for path in other.storage.list(f"{other.prefix}/raw/"):
            name = path.rsplit("/", 1)[1]
            if name in have or slots <= 0:
                continue
            found = other.storage.read(path)
            if found:
                self.storage.write(f"{self.prefix}/raw/{name}", found[0], "application/octet-stream")
                slots -= 1
        self.record_files(other.manifest())
        return outcome


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
