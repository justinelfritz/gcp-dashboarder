# Panel queries

`POST /sessions/{id}/query` (a guest session) or `POST /me/query` (the signed-in user, with a
Firebase ID token as `Authorization: Bearer …`) takes a display's filters and a batch of panel
definitions and
returns plot-ready series for each panel. All values are metric (m, s, m/s, s/km, W); the
frontend converts units for display.

## Request

```json
{
  "filters": {
    "activity_types": ["run"],
    "activity_subtypes": { "run": ["trail"] },
    "date_range": { "last_days": 60 },
    "filters": []
  },
  "distance_tolerance": 0.025,
  "panels": [ ... ]
}
```

`activity_subtypes` narrows a sport to some subtypes; sports not listed keep all of theirs (here:
trail runs only). Subtypes: `standard` (the file names none, e.g. Garmin's plain "Running"),
`trail`, `track`, `road`, `gravel`, `mountain`, `cyclocross`, `e_bike`. They're derived from the
source's own type (FIT `running/trail`, Garmin CSV "Trail Running", Strava "Trail Run"), and
`activity_subtype` is also an activity field that panel and series filters can use.

`date_range` takes `last_days`, or `start`/`end` as local dates (inclusive).
`activity_ids` limits the display to those activities; `exclude_activity_ids` leaves those out.
Both apply after the sport and date filters.

## Panel

| Key | Values | Default |
|---|---|---|
| `group_by` | `activity` (a point per activity), `week`, `month` (Monday-start, local time), `point` (a point per lap or record) | `activity` |
| `x`, `y` | `{ "field", "level": "activity" \| "lap" \| "record", "agg" }` | x = activity `start_time` |
| `agg` | `mean`, `median`, `min`, `max`, `sum`, `count`, `std`: combines lower-level rows into a point | `mean` |
| `error` | `none`, `std`, `sem`: spread of the rows behind each y value | `none` |
| `lap_kind` | `device`, `split_km`, `split_mi` | `device` |
| `include_partial_laps` | include the shorter final lap/split | `false` |
| `filters` | activity-level conditions for the whole panel | `[]` |
| `series` | `[{ "label", "color", "filters" }]`, one plotted series each | one series, "All" |

Up to 48 panels per request. The web app plots a panel's optional right-axis quantity by
sending a companion panel: the same definition with id `<panel id>~y2` and its own `y`.

Filters: `{ "field", "op", "value", "tolerance"? }` with `op` one of `eq`, `neq`, `in`,
`between` (`[lo, hi]`), `gte`, `lte`, `near` (value ± tolerance; tolerance defaults to the
request's `distance_tolerance`).

`GET /sessions/{id}/fields?activity_type=run` lists every field per level, with units and how
many of the selected activities have data for it, plus `subtypes`: the count of selected
activities per sport and subtype (`{ "run": { "trail": 5, "standard": 5 } }`).

## Examples

Average lap pace per run with standard-deviation error bars:

```json
{ "id": "lap-pace", "y": { "field": "avg_pace_s_per_km", "level": "lap" }, "error": "std" }
```

Average speed ± std from per-second data, 5k runs vs 10k runs as two colored series:

```json
{
  "id": "speed-by-distance",
  "y": { "field": "speed", "level": "record" },
  "error": "std",
  "series": [
    { "label": "5k", "color": "#1f77b4",
      "filters": [{ "field": "distance_m", "op": "near", "value": 5000 }] },
    { "label": "10k", "color": "#ff7f0e",
      "filters": [{ "field": "distance_m", "op": "near", "value": 10000 }] }
  ]
}
```

Runs and rides as separate series:

```json
{
  "id": "speed-by-sport",
  "y": { "field": "avg_speed_mps" },
  "series": [
    { "label": "Runs", "filters": [{ "field": "activity_type", "op": "eq", "value": "run" }] },
    { "label": "Rides", "filters": [{ "field": "activity_type", "op": "eq", "value": "ride" }] }
  ]
}
```

Trail runs and standard runs as separate series (the web app's "Split by subtype"):

```json
{
  "id": "pace-by-subtype",
  "y": { "field": "avg_pace_s_per_km" },
  "series": [
    { "label": "Trail", "filters": [{ "field": "activity_subtype", "op": "eq", "value": "trail" }] },
    { "label": "Standard", "filters": [{ "field": "activity_subtype", "op": "eq", "value": "standard" }] }
  ]
}
```

Pace against cadence, one point per run:

```json
{ "id": "pace-vs-cadence", "x": { "field": "avg_cadence" }, "y": { "field": "avg_pace_s_per_km" } }
```

Weekly distance:

```json
{ "id": "weekly", "group_by": "week", "y": { "field": "distance_m", "agg": "sum" } }
```

One activity's heart rate over time, as the web app's individual activity mode sends it: the
request's `filters` are `{ "activity_ids": ["<id>"] }`, and every panel is in point mode:

```json
{ "id": "hr", "group_by": "point", "x": { "field": "elapsed_s", "level": "record" }, "y": { "field": "hr", "level": "record" } }
```

## Response

Each panel returns `x`/`y` axis info (label, unit), `series` of `points`
(`{ x, y, error, n, activity_id }`, sorted by x; dates are the activity's local time, without an
offset), `warnings` (e.g. activities without lap data),
and `error` if the panel definition is invalid. One bad panel never fails the batch.
