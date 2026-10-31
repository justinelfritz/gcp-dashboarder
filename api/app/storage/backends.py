"""Blob storage backends: Cloud Storage in deployed environments, local disk for development.

Both support optimistic concurrency: `read` returns a generation number and `write` can require
the object to still be at that generation (0 means "must not exist yet").
"""

import os
import shutil
import threading
from pathlib import Path
from typing import Protocol


class PreconditionFailed(Exception):
    """The object changed since it was read."""


class Storage(Protocol):
    def read(self, path: str) -> tuple[bytes, int] | None: ...

    def write(
        self, path: str, data: bytes, content_type: str, if_generation: int | None = None
    ) -> int:
        """Store the object; returns its new generation."""
        ...

    def list(self, prefix: str) -> list[str]: ...

    def delete(self, path: str) -> None:
        """Remove one object; a missing object is not an error."""
        ...

    def delete_prefix(self, prefix: str) -> int:
        """Remove every object under the prefix; returns how many were removed."""
        ...

    def usage(self, prefix: str) -> tuple[int, int]:
        """Object count and total bytes under the prefix."""
        ...


def _generation(path: Path) -> int:
    # Modification time in microseconds: like a GCS generation, it stays below 2**53, so it
    # survives a round trip through JSON in the browser (nanoseconds would not).
    return path.stat().st_mtime_ns // 1000


class LocalStorage:
    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self._lock = threading.Lock()

    def _resolve(self, path: str) -> Path:
        full = (self.root / path).resolve()
        if not full.is_relative_to(self.root):
            raise ValueError("path escapes storage root")
        return full

    def read(self, path: str) -> tuple[bytes, int] | None:
        full = self._resolve(path)
        with self._lock:
            if not full.exists():
                return None
            return full.read_bytes(), _generation(full)

    def write(self, path, data, content_type, if_generation=None) -> int:
        full = self._resolve(path)
        with self._lock:
            if if_generation is not None:
                current = _generation(full) if full.exists() else 0
                if current != if_generation:
                    raise PreconditionFailed(path)
            full.parent.mkdir(parents=True, exist_ok=True)
            tmp = full.with_suffix(full.suffix + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, full)
            return _generation(full)

    def delete(self, path: str) -> None:
        with self._lock:
            self._resolve(path).unlink(missing_ok=True)

    def delete_prefix(self, prefix: str) -> int:
        base = self._resolve(prefix)
        if base == self.root:
            raise ValueError("refusing to delete the whole storage root")
        with self._lock:
            if not base.exists():
                return 0
            count = sum(1 for p in base.rglob("*") if p.is_file())
            shutil.rmtree(base)
            return count

    def list(self, prefix: str) -> list[str]:
        base = self._resolve(prefix)
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file())

    def usage(self, prefix: str) -> tuple[int, int]:
        base = self._resolve(prefix)
        files = [p for p in base.rglob("*") if p.is_file()] if base.exists() else []
        return len(files), sum(p.stat().st_size for p in files)


class GcsStorage:
    def __init__(self, bucket: str) -> None:
        from google.cloud import storage

        self._client = storage.Client()
        self._bucket = self._client.bucket(bucket)

    def read(self, path: str) -> tuple[bytes, int] | None:
        blob = self._bucket.get_blob(path)
        if blob is None:
            return None
        # If the object changes after this, the caller's conditional write fails and retries.
        return blob.download_as_bytes(), blob.generation

    def write(self, path, data, content_type, if_generation=None) -> int:
        from google.api_core import exceptions

        blob = self._bucket.blob(path)
        try:
            blob.upload_from_string(
                data, content_type=content_type, if_generation_match=if_generation
            )
        except exceptions.PreconditionFailed as exc:
            raise PreconditionFailed(path) from exc
        return blob.generation

    def delete(self, path: str) -> None:
        from google.api_core import exceptions

        try:
            self._bucket.blob(path).delete()
        except exceptions.NotFound:
            pass

    def delete_prefix(self, prefix: str) -> int:
        if not prefix.strip("/"):
            raise ValueError("refusing to delete the whole bucket")
        blobs = list(self._client.list_blobs(self._bucket, prefix=prefix))
        # Batched requests: thousands of objects go in a few dozen round trips.
        for i in range(0, len(blobs), 100):
            with self._client.batch(raise_exception=False):
                for blob in blobs[i: i + 100]:
                    blob.delete()
        return len(blobs)

    def list(self, prefix: str) -> list[str]:
        return [b.name for b in self._client.list_blobs(self._bucket, prefix=prefix)]

    def usage(self, prefix: str) -> tuple[int, int]:
        blobs = list(self._client.list_blobs(self._bucket, prefix=prefix))
        return len(blobs), sum(b.size or 0 for b in blobs)
