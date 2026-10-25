"""Blob storage backends: Cloud Storage in deployed environments, local disk for development.

Both support optimistic concurrency: `read` returns a generation number and `write` can require
the object to still be at that generation (0 means "must not exist yet").
"""

import os
import threading
from pathlib import Path
from typing import Protocol


class PreconditionFailed(Exception):
    """The object changed since it was read."""


class Storage(Protocol):
    def read(self, path: str) -> tuple[bytes, int] | None: ...

    def write(
        self, path: str, data: bytes, content_type: str, if_generation: int | None = None
    ) -> None: ...

    def list(self, prefix: str) -> list[str]: ...


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
            return full.read_bytes(), full.stat().st_mtime_ns

    def write(self, path, data, content_type, if_generation=None) -> None:
        full = self._resolve(path)
        with self._lock:
            if if_generation is not None:
                current = full.stat().st_mtime_ns if full.exists() else 0
                if current != if_generation:
                    raise PreconditionFailed(path)
            full.parent.mkdir(parents=True, exist_ok=True)
            tmp = full.with_suffix(full.suffix + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, full)

    def list(self, prefix: str) -> list[str]:
        base = self._resolve(prefix)
        if not base.exists():
            return []
        return sorted(str(p.relative_to(self.root)) for p in base.rglob("*") if p.is_file())


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

    def write(self, path, data, content_type, if_generation=None) -> None:
        from google.api_core import exceptions

        try:
            self._bucket.blob(path).upload_from_string(
                data, content_type=content_type, if_generation_match=if_generation
            )
        except exceptions.PreconditionFailed as exc:
            raise PreconditionFailed(path) from exc

    def list(self, prefix: str) -> list[str]:
        return [b.name for b in self._client.list_blobs(self._bucket, prefix=prefix)]
