# Dashboarder

Web app for uploading activity files (CSV, FIT) and building custom fitness dashboards.
The full plan is in `dashboarder-plan.md`; architecture decisions are logged in `docs/decisions.md`.

## Stack

- API: Python 3.12 + FastAPI in `api/`, managed with `uv`. Deployed to Cloud Run.
- Web: React + TypeScript + Vite in `web/`.
- Storage: Cloud Storage + Parquet. No database in v1.

## Commands

- API tests: `cd api && uv run pytest`
- API lint: `cd api && uv run ruff check .`
- API dev server: `cd api && uv run uvicorn app.main:app --reload --port 8080`
- Web tests: `cd web && npm test`
- Web dev server: `cd web && npm run dev` (expects the API on `localhost:8080`)
- Deploy: `PROJECT_ID=... ENV=dev ./infra/deploy.sh`

## Conventions

- Metrics must return null for missing inputs, never raise on sparse data.
- Units are metric internally (m, s, W, m/s). Convert only in the frontend.
- Never log uploaded file contents. Log session ID, file size, and parse counts only.
- Keep the dashboard JSON `schema_version` in sync with the frontend types.
- Keep `web/src/api/client.ts` types in sync with `api/app/models.py`.
- Panel query format: `docs/panel-queries.md`. Chart rendering is a pure function
  (`web/src/charts/buildFigure.ts`); test figures there rather than through Plotly.
- Chart colors come from the validated palette in `web/src/charts/palette.ts`; don't add hues.
