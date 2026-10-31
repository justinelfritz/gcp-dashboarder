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

## 2026-10-25: Milestone 3, user-defined panels

Scope and design agreed for custom multi-panel displays. Format reference: `docs/panel-queries.md`.

- **Scope: outdoor runs, rides, and hikes.** Other types (strength, yoga, walks, swims) and
  indoor activities (treadmill, trainer, virtual) are stored but hidden from every endpoint, so
  they can be supported later without re-uploading.
- **Panels are declarative, not named metrics.** Each panel chooses a level (activity, lap,
  record), fields for x and y, an aggregation, error bars (std or sem), what one point is
  (activity, week, month, or each row), and series with their own filters. This replaces the
  plan's metric registry. The engine uses pandas (no SQL is generated from user input).
- **Distance bins default to ±2.5%** (`near` filter: 5k = 4,875–5,125 m). The request carries
  the user's `distance_tolerance` setting; a filter can override it.
- **Laps: device laps and computed splits (per km and per mile)**, in one `laps.parquet` per
  session. Every lap metric is recomputed from records with the same rules, so the two kinds are
  comparable; device laps contribute only their boundaries and ascent. Partial final laps are
  excluded by default. Validated on real files: distance within 2 m, HR within 1 bpm, cadence
  exact against the watch's lap values.
- **Record-level speed and pace use moving samples only** (> 0.3 m/s), so stops don't distort
  means and standard deviations.
- **Cadence is steps/min for runs and hikes** (FIT stores per-leg cadence; doubled, plus the
  fractional part) and rpm for rides. Averages are plain means over all samples, which matches
  Garmin Connect exactly.
- **Elevation gain follows the device.** Garmin's barometric smoothing can't be reproduced from
  samples (no single threshold came within 9–32% on all files), so device laps use the watch's
  lap ascent and computed splits are scaled to sum to the watch's total.
- **Weeks start Monday in the activity's local time.**
- **ZIP import happens in the browser** (zip.js). Exports run to several GB (over Cloud Run's
  32 MiB request limit) and contain sleep, health, profile, and photo data. The browser keeps
  only `.fit`/`.fit.gz` files and CSVs with an activity-export header, strips the account email
  from Garmin file names, and uploads in batches of at most 20 MB / 50 files. GPX/TCX are counted
  and skipped.
- **Per-session file cap raised to 5,000** (was 500) so multi-year Garmin exports fit.

## 2026-10-25: Milestone 4, dashboard UI

- **Grid:** react-grid-layout 1.5 (12 columns, drag by panel title, resize from the corner). Only
  the wide layout is saved; under 900 px panels stack in one column. Pinned to 1.5.x and
  plotly.js 2.35.x, the last releases of the APIs we know; 2.x/3.x+ of each exist and would be a
  deliberate upgrade. Checked react-grid-layout renders under React 19 without `findDOMNode`.
- **Charts:** Plotly (basic bundle: scatter and bar, with native error bars), lazy-loaded as its
  own chunk so the first page load stays small. `web/src/charts/buildFigure.ts` is a pure
  function from a query result to a figure and a table, unit-tested without a browser.
- **Visual rules** (from the dataviz guidance): one y axis per panel (since relaxed, see
  2026-10-30); a validated 8-color
  palette assigned by series slot, with separate dark-mode steps; legend only for 2+ series;
  2 px lines, 8 px markers with a surface ring; hairline grid; pace axes reversed (faster is
  up) with m:ss ticks; every panel has a table view (useful for checking numbers against Garmin
  Connect, and for readers who can't rely on color).
- **Palette contrast in both modes.** The reference palette's light aqua, yellow and magenta
  were under 3:1 on the light surface. They are replaced by darker steps of the same hues
  (`#01a773`, `#bd7f03`, `#da6f98`), found by searching OKLCH lightness for the set that keeps
  the validator's gates: every slot is now >= 3:1 in both modes, worst adjacent CVD ΔE 10.0 and
  normal-vision 17.6 in light, and the first three slots still pass all-pairs for scatter.
- **Dates are the activity's local time.** The API returns local wall-clock times for date axes,
  and the frontend does date math in UTC so the viewer's own timezone never shifts them.
- **Units:** the API stays metric; `web/src/charts/units.ts` converts for display. Units are a
  display setting and don't refetch; the distance tolerance is a query setting and does.
- **Dashboards** (`schema_version: 1`) live in localStorage, several per browser, with JSON
  export/import. Imported files are validated field by field and IDs are regenerated. Series
  store a palette slot, not a hex color, so dark mode can swap shades.
- **Series filters:** a target distance (± tolerance) and an optional sport, so one panel can
  compare 5k vs 10k runs, or runs vs rides.

## 2026-10-25: Hand-picked activity selection

- Each dashboard can analyze a subset of the activities that match its sports and date range,
  chosen in an "Activities" picker: checkboxes, name search, a from/to date range that narrows
  the list for bulk check/uncheck, and shift-click for runs of rows.
- **Stored as a mode plus IDs** (`filters.selection`): `all` lists the excluded activities, so
  new uploads are analyzed automatically; `only` lists the included ones, for "just these
  runs". "Pick individually" starts an empty `only` selection. Everything selected is stored as
  no selection at all. Sent to the API as `activity_ids` / `exclude_activity_ids`.
- An optional field, so `schema_version` stays 1: older saved dashboards load unchanged.
  Activity IDs are per session, so an imported dashboard's selection only matches activities in
  the session that exported it.
- `GET /activities` now takes `last_days` and filters through the same code as queries, so the
  picker lists exactly the activities a dashboard's date preset covers. Its limit rose to 5000
  (the per-session file cap); the activity-name lookup for chart tooltips was capped at 500.

## 2026-10-30: Optional right-hand y axis

- A panel can plot a second quantity (`y2`) on a right-hand axis, sharing x, grouping, laps,
  filters, and series with the first. This reverses the one-axis rule above at the user's
  request. Comparing, say, pace and heart rate on one plot was worth more to them than the cost:
  the two scales are arbitrary relative to each other, so line heights, slopes, and crossings
  can't be compared across axes. The editor says so under the control.
- Mitigations, so a reader can always tell which line reads against which axis:
  - right-axis traces default to palette slots the left series don't use, so no hue is shared;
  - they are dashed by default, always have open markers, and are never bars, since bars on
    two axes overlap;
  - the user can pick each series' right-axis color (`y2_color_slot`) and the line style
    (`y2_line`: dashed, dotted, solid). The editor warns when a pick removes a cue: a color
    shared with a left line, or solid lines;
  - legend entries and hover name the quantity, and the legend shows even with one series;
  - axis titles stay in text ink with a mark hint ("— Pace", "Heart rate - -");
  - only the left axis draws gridlines.
- **A companion query, not an API change.** The web app sends the panel twice, the second with
  id `<panel id>~y2` and `y` swapped for `y2`, so the engine stays one-quantity-per-panel. The
  request cap rose from 24 to 48 panel queries to cover 24 panels with a second quantity each.
  Record-level quantities read the session's records twice; move `y2` into the API if that's
  slow.
- The table joins both quantities on series, x, and activity. With one point per lap or sample
  there's no join key, so each quantity's points are listed with a "Quantity" column.
- `y2` is optional, so `schema_version` stays 1.

## 2026-10-31: Least-squares trendlines

- Each quantity (left and right axis) has its own trendline toggle (`trend`, `y2_trend`). One
  ordinary least-squares line per series, fitted in the browser to the values as plotted: display
  units, with dates as wall-clock time. No API change, and toggling doesn't refetch.
- Drawn as a thin, translucent line in the series' color over the series' own x range. It shares
  the series' legend entry, so hiding a series hides its trend.
- The rate of change and r² are listed under the panel (per week on date axes, per month for
  monthly points, per x unit otherwise), so the trend can be read without hovering.
- The fit uses only the plotted points: weeks or months with no activities are left out rather
  than counted as zero. A series needs two distinct x values to get a trend.

## 2026-10-31: Cloud Run readiness

- **Health check is `/health`, not `/healthz`.** Cloud Run reserves paths ending in `/healthz`
  and answers them itself, so the frontend's startup check (which gates session creation) would
  never reach the app.
- **Concurrency 4 per instance** (Cloud Run's default is 80). Queries are CPU- and memory-heavy
  pandas work in 1 vCPU / 1 GiB; a few large ones at once could exhaust memory, so Cloud Run
  starts another instance instead (up to the max of 5). Revisit after measuring real queries.
