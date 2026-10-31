# Dashboarder: Preliminary Build Plan (v1)

Working plan for use with Claude Code in the IDE. Treat it as a starting point: decisions marked **Open** should be settled before the relevant milestone.

## 1. Goal

A web app where users upload activity files (CSV and FIT), then build custom dashboards of graphs and tables. Metrics (raw or derived) are computed on demand so the app works with variable source data. The goal is to show fitness trends clearly enough to identify growth areas for training focus.

## 2. Scope

### In scope for v1
- Upload one or more CSV and FIT files per session.
- Parse and normalize activities into one common schema.
- Build dashboards from panels: time series chart, bar/category chart, summary stat tile, and data table.
- Compute raw and derived metrics on demand (for example, rolling averages, weekly totals, period-over-period change, personal bests).
- Filter by date range, activity type, and other fields.
- Save dashboard layouts in the browser (localStorage) and allow JSON export/import.

### Out of scope for v1
- User accounts and sign-on.
- API sync with Strava, Garmin Connect, or others.
- Sharing dashboards between users.
- Mobile-native apps.
- Precomputed or cached metric pipelines.

## 3. Assumptions

- Platform: Google Cloud Platform.
- Users are anonymous. Each browser gets a random session ID, and uploaded data is tied to that ID.
- Each user has hundreds of activities, which is small enough to hold in memory per request. Target: a dashboard query over 1,000 activities should return in under 1 second.
- Cloud Run instances can scale to zero and any instance can serve any request, so uploaded data must live in durable storage, not instance memory.

## 4. Architecture

```
Browser (React SPA)
  │  HTTPS
  ▼
Cloud Run: api (Python / FastAPI)
  ├── POST /sessions/{id}/uploads   → parse CSV/FIT → write normalized Parquet to GCS
  ├── GET  /sessions/{id}/activities → list/filter activity metadata
  └── POST /sessions/{id}/query     → load Parquet, compute metrics on demand, return series/tables
  │
  ▼
Cloud Storage bucket
  ├── sessions/{session_id}/raw/      original uploaded files
  └── sessions/{session_id}/normalized/ activities.parquet (+ per-file parse reports)
  (lifecycle rule: delete session prefixes after N days of inactivity)

Static frontend: Cloud Storage bucket + Cloud CDN (or Firebase Hosting)
```

Notes:
- No database in v1. Storage is GCS plus Parquet, which keeps the stack small. Revisit when accounts arrive (Firestore or Cloud SQL for user and dashboard records).
- Pandas or DuckDB runs the on-demand queries against the Parquet file. DuckDB is a good fit for filter-and-aggregate work over one file.

## 5. Data model

### Normalized activity schema (one row per activity; one table per time series)

Activity table (`activities.parquet`):
- `activity_id` (string, generated)
- `source_file` (string)
- `source_format` (`csv` | `fit`)
- `start_time` (timestamp, UTC)
- `activity_type` (string, normalized: run, ride, swim, strength, other)
- `duration_s` (float)
- `distance_m` (float, nullable)
- `elevation_gain_m` (float, nullable)
- `avg_hr`, `max_hr` (int, nullable)
- `avg_power_w`, `normalized_power_w` (float, nullable)
- `avg_pace_s_per_km` or `avg_speed_mps` (float, nullable)
- `calories` (float, nullable)
- Additional columns preserved under a `raw_` prefix where unmapped

Record-level data (FIT files contain second-by-second records): store as a separate Parquet file (`records.parquet`) keyed by `activity_id`, with `timestamp`, `hr`, `power`, `cadence`, `speed`, `altitude`, `lat`, `lon`. Only load it when a query needs it.

### Dashboard definition (JSON, stored in localStorage for v1)

```json
{
  "id": "dash_01",
  "name": "Run base building",
  "filters": { "activity_type": ["run"], "date_range": "last_180_days" },
  "panels": [
    {
      "id": "p1",
      "type": "timeseries",
      "metric": "weekly_distance_km",
      "transform": { "rolling_window_days": 28 },
      "layout": { "x": 0, "y": 0, "w": 6, "h": 4 }
    },
    {
      "id": "p2",
      "type": "stat",
      "metric": "personal_best_5k_s",
      "layout": { "x": 6, "y": 0, "w": 3, "h": 2 }
    }
  ]
}
```

Keep this schema versioned (`"schema_version": 1`) from the start.

## 6. Metric engine

- Implement metrics as small, named functions in one module (for example, `metrics/registry.py`), each taking a DataFrame and parameters and returning a series or table.
- Each metric declares its inputs (activity fields, or record-level data) so the query layer knows whether to load record data.
- Initial set (keep it small):
  - Raw: duration, distance, elevation, HR, power per activity
  - Aggregated: weekly/monthly totals and averages
  - Derived: rolling averages, period-over-period change, personal bests over fixed distances (requires record data), training load proxy (for example, TSS-like score from duration and intensity, if power or HR is available)
- Every metric must handle missing fields by returning null, not failing. Fitness files vary a lot.

**Open:** Which training load formula to use, and whether to expose it in v1.

## 7. API

| Method | Path | Purpose |
|---|---|---|
| POST | `/sessions` | Create an anonymous session, return `session_id` |
| POST | `/sessions/{id}/uploads` | Upload CSV/FIT (multipart). Returns parse summary and warnings |
| GET | `/sessions/{id}/activities` | Paginated activity list with filters |
| POST | `/sessions/{id}/query` | Body: panel definition(s) plus filters. Returns series/table data |
| GET | `/health` | Health check (not `/healthz`, which Cloud Run reserves) |

Use one query endpoint that accepts a batch of panel definitions. This lets the frontend fetch a whole dashboard in one request.

## 8. Parsing

- **FIT:** Use the official Garmin FIT SDK for Python, or `fitparse`. Prefer the official SDK. Extract `session` messages for activity summaries and `record` messages for record-level data.
- **CSV:** Auto-detect common column names (for example, `Distance`, `Avg HR`, `Duration`, `Date`). Unrecognized columns are kept as `raw_` columns. Show a mapping step in the UI when detection fails.
- Units: normalize to metric internally (meters, seconds, watts), and convert for display in the frontend.
- Timezones: store UTC. Keep the original timezone offset if present.
- Every upload returns a parse report: rows accepted, rows rejected, and reasons. Do not fail the whole upload because one row is bad.
- Validate file size and count (for example, max 50 MB per file, max 500 files per session) to protect the service.

## 9. Frontend

- React with Vite. TypeScript recommended.
- Charting: Apache ECharts or Recharts for time series and bars; a simple table component for tables.
- Layout: a grid layout library (for example, react-grid-layout) for drag-and-resize panels.
- State: dashboard JSON in one store, persisted to localStorage. Panels request data from `/query` when filters or definitions change. Debounce filter changes.
- Empty and error states: show parse warnings and missing-field notices per panel rather than blank charts.

## 10. Security and privacy (v1)

- No accounts, so no passwords or PII are stored. Session data expires via the bucket lifecycle rule.
- Tell users that uploads are stored for N days and can be deleted with a "clear my data" action (`DELETE /sessions/{id}`).
- Restrict upload types by content, not just extension. Limit file size at the Cloud Run level and in code.
- Use signed URLs if the frontend ever uploads directly to GCS. For v1, uploading through the API is simpler.
- Do not log file contents. Log session ID, file size, and parse counts only.

**Open:** Retention period (suggested: 7 days of inactivity), and whether users need a visible privacy notice before first upload.

## 11. GCP setup

- One project for dev and one for prod, or one project with separate resource names. Decide early.
- Cloud Run service: `api` (Python container). Start with min instances 0; set to 1 later if cold starts bother users.
- Cloud Storage: one bucket for session data (private), one for static frontend (public through CDN).
- Cloud Build or GitHub Actions to build and deploy the container.
- Secret Manager only if an external API is added later.
- Cloud Logging and Error Reporting are on by default. Add basic alerts on 5xx rate.
- Infrastructure as code: start with `gcloud` commands in a script, or Terraform once the layout stabilizes. Terraform is worth it if you expect to rebuild environments.

## 12. Repository layout (suggested)

```
dashboarder/
  CLAUDE.md                 # project conventions for Claude Code (see section 14)
  api/
    app/
      main.py               # FastAPI app and routes
      parsing/
        csv_parser.py
        fit_parser.py
        schema.py           # normalized column definitions
      metrics/
        registry.py
        rolling.py
        personal_bests.py
      storage/
        gcs.py
      models.py             # pydantic request/response models
    tests/
      fixtures/             # small sample CSV and FIT files
    Dockerfile
    pyproject.toml
  web/
    src/
      components/
      dashboard/            # layout, panel registry, dashboard store
      api/                  # typed client for the API
      charts/
    package.json
  infra/
    README.md               # gcloud or Terraform steps
  docs/
    decisions.md            # architecture decision log
```

## 13. Milestones

1. **Skeleton:** Repo layout, FastAPI health check, React shell, Cloud Run deploy of both. Confirm the pipeline works end to end.
2. **Parsing:** CSV and FIT parsers with tests against small fixture files. Normalized Parquet written to GCS. Parse report returned.
3. **Query engine:** Activity listing and filtering. Three metrics (weekly distance, average HR by week, personal best for one distance) implemented and tested.
4. **Dashboard UI:** One time-series panel and one table panel wired to `/query`. Dashboard saved to localStorage. JSON export/import.
5. **Panel set:** Add stat tiles, bar charts, rolling averages, and the remaining metrics.
6. **Hardening:** Upload limits, error states, session deletion, retention rule, privacy notice.
7. **Polish and deploy:** Layout improvements, performance check with a few hundred activities, documentation.

## 14. Notes for Claude Code

Suggested `CLAUDE.md` contents for the repo root:
- Stack: Python 3.12 + FastAPI for the API, React + TypeScript + Vite for the web app, GCP (Cloud Run, Cloud Storage).
- Run tests with `pytest` in `api/` and `npm test` in `web/`.
- Metrics must return null for missing inputs, never raise on sparse data.
- Units are metric internally (m, s, W, m/s). Convert only in the frontend.
- Never log uploaded file contents.
- Keep the dashboard JSON `schema_version` in sync with the frontend types.

Suggested first prompts for Claude Code:
1. "Scaffold the repo layout in section 12 with a FastAPI health check and a Vite React app. Add a Dockerfile for the API."
2. "Write the CSV parser for the normalized schema in section 5, with pytest tests using small fixture files."
3. "Implement the FIT parser using the Garmin FIT SDK. Extract session summaries first; add record data after tests pass."

## 15. Open questions

1. Which activity sources matter first beyond Garmin and Strava exports (for example, Wahoo, Apple Health)? Each one changes the CSV column mapping.
2. Which metrics matter most for training focus? This sets the v1 metric list.
3. Session retention period and privacy wording.
4. Whether dashboards should be shareable by link before accounts exist.
5. Target browsers and whether mobile layout matters in v1.
6. Training load formula, if one is included.