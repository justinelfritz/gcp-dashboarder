FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /usr/local/bin/uv

WORKDIR /srv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app

RUN useradd --system --uid 10001 appuser
USER appuser

ENV PATH="/srv/.venv/bin:$PATH" PORT=8080 \
    DASHBOARDER_LOCAL_STORAGE_DIR=/tmp/dashboarder-data
EXPOSE 8080
# Cloud Run sets $PORT; default to 8080 locally.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
