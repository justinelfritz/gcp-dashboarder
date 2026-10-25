# Architecture decisions

## 2026-10-24: Milestone 1 skeleton

- **One GCP project per environment is supported but not required.** Resource names carry an
  `ENV` suffix, so dev and prod can share a project or not.
- **API deploys with `gcloud run deploy --source`** (Cloud Build builds the Dockerfile). Revisit
  when CI is added.
- **Frontend served from a public GCS bucket** without CDN for now. Firebase Hosting or Cloud CDN
  comes before launch (see `infra/README.md`).
- **Session IDs are 32-character random tokens** from `secrets.token_urlsafe`, because the ID is
  the only access control on a session's data in v1.
- **Retention defaults to 7 days since upload**, enforced by a bucket lifecycle rule. This is age
  based, not inactivity based; see the open question in the plan.

## 2026-10-24: Milestone 2 parsing

- **Supported inputs:** Garmin FIT (`.fit`, and `.fit.gz` as found in Strava bulk exports),
  Garmin Connect activities CSV, and Strava `activities.csv`. GPX/TCX and whole-export ZIP
  uploads are not supported yet.
- **Garmin CSV needs the user's timezone and unit system.** The export has local times with no
  offset and values in display units with no labels, and nothing in the file reliably tells km
  from miles. The upload takes `timezone` (IANA) and `units` (`metric`|`imperial`); the frontend
  should default them from the browser and let the user change them.
- **Cross-source dedupe:** activities with the same type starting within 60 s are one activity.
  FIT beats CSV as the base row; the other row fills its gaps (e.g. the Strava name). Equal
  priority keeps the row already stored.
- **Records are stored one Parquet file per activity** (`normalized/records/{activity_id}.parquet`)
  instead of a single `records.parquet`, so an upload never rewrites other activities' data.
- **Concurrent uploads** are safe: `activities.parquet` is written with a GCS generation
  precondition and the merge retries on conflict.
- **Speed, not pace:** the schema stores `avg_speed_mps`; the frontend derives pace.
- **Max file size is 25 MB**, below Cloud Run's 32 MiB HTTP/1 request limit. The frontend should
  send large batches as several requests.
- **FIT test fixtures are generated** by `api/tests/fit_builder.py` and checked by decoding with the
  official SDK. They still need validating against real device files.

## 2026-10-25: Validated against real Garmin exports

Checked against a real Garmin Connect CSV (140 activities) and 5 FIT files from the same account
(run, trail run, gravel ride, hike, strength). Tests in `api/tests/test_private_fixtures.py` run
when files are present in the git-ignored `api/tests/fixtures/private/`.

- **Garmin CSV units follow the account's display setting** (imperial: miles, feet), but some
  columns stay metric regardless (e.g. Avg Stride Length in meters). Confirmed by matching CSV
  rows to FIT files. The upload's `units` must match the Garmin account setting.
- **FIT moving time is derived from records** (speed > 0.3 m/s, gaps over 30 s ignored, capped at
  timer time). This matches Garmin Connect's Moving Time to the second for runs and hikes and
  within 0.2% for rides. Without speed data (strength, yoga) it uses the session's
  `active_time`, which matches Garmin for strength. Timer time is not moving time: it includes
  stops while the timer runs.
- **Motorized activities** (Motorcycling) map to `other`, not `ride`.
- Garmin prefixes some negative numbers with an apostrophe (`'-12`); the CSV parser strips it.
