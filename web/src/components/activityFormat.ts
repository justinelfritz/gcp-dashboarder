// How an activity is described in lists and headers.
import { subtypeLabel } from '../api/client'
import type { ActivitySummary } from '../api/client'

const SPORTS: Record<string, string> = { run: 'Run', ride: 'Ride', hike: 'Hike' }

/** The activity's local calendar date, YYYY-MM-DD. */
export function localDay(a: ActivitySummary): string {
  const ms = Date.parse(a.start_time) + (a.tz_offset_min ?? 0) * 60_000
  return new Date(ms).toISOString().slice(0, 10)
}

/** "Sat, Sep 5, 2026": the local date, in the browser's language. */
export function dayLabel(a: ActivitySummary): string {
  return new Date(`${localDay(a)}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric', weekday: 'short',
  })
}

/** "Run", or "Run · Trail" when the source names a subtype. */
export function sportLabel(a: ActivitySummary): string {
  const sport = SPORTS[a.activity_type] ?? a.activity_type
  return a.activity_subtype && a.activity_subtype !== 'standard' ? `${sport} · ${subtypeLabel(a.activity_subtype)}` : sport
}

/** "Sat, Sep 5, 2026 · 8:02 AM": the local start, in the browser's language. */
export function startLabel(a: ActivitySummary): string {
  const ms = Date.parse(a.start_time) + (a.tz_offset_min ?? 0) * 60_000
  const time = new Date(ms).toLocaleTimeString(undefined, { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })
  return `${dayLabel(a)} · ${time}`
}
