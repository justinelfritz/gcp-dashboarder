from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration, read from environment variables prefixed DASHBOARDER_."""

    model_config = SettingsConfigDict(env_prefix="DASHBOARDER_")

    # Comma-separated list of allowed CORS origins for the web app.
    cors_origins: str = "http://localhost:5173"
    # GCS bucket for session data. Empty means use local storage (dev only).
    session_bucket: str = ""
    local_storage_dir: str = ".data"
    # Cloud Run caps HTTP/1 request bodies at 32 MiB, so a single file must stay below that.
    max_file_bytes: int = 25 * 1024 * 1024
    # Garmin full exports hold one FIT file per activity, so years of history means thousands.
    max_files_per_session: int = 5000

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
