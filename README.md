# Custom Dashboarder

Upload activity files and build custom dashboards of fitness trends.

## Supported files

| Format | Source | Notes |
|---|---|---|
| `.fit` | Garmin devices and Garmin Connect | Full detail: laps and per-second records. |
| `.fit.gz` | Strava bulk export | Gzipped FIT, read the same way as `.fit`. |
| `.csv` | Garmin Connect activities export | Summaries only. Choose your timezone and units when uploading, because the file doesn't say which it uses. |
| `.csv` | Strava `activities.csv` | Summaries only. |
| `.zip` | Garmin full account export, Strava archive | Unpacked in the browser, including nested ZIPs. Only activity files are uploaded. |

- Only outdoor runs, rides and hikes appear in dashboards. Other activities are stored but hidden.
- An activity that appears in more than one file (for example a FIT file and a CSV row) is
  merged, keeping the FIT data.
- Not supported yet: GPX and TCX. These are counted and skipped, including inside ZIPs.
- Limits: 25 MB per file, 5,000 files per session.

## Layout

- `api/`: FastAPI service (Cloud Run)
- `web/`: React + Vite frontend
- `infra/`: GCP deploy script
- `docs/`: decision log and panel query format

See `CLAUDE.md` for commands and `dashboarder-plan.md` for the full plan.
