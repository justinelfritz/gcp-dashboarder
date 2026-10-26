// Translating dashboard definitions into API queries, plus starter content.
import type { DateRange, DisplayFilters, PanelQuery, QueryRequest } from '../api/client'
import { newId, SCHEMA_VERSION } from './types'
import type { ActivitySelection, Dashboard, DashboardFilters, PanelConfig, Settings } from './types'

const PRESET_DAYS: Record<string, number> = {
  last_30: 30,
  last_60: 60,
  last_90: 90,
  last_180: 180,
  last_365: 365,
}

export function toDateRange(f: DashboardFilters): DateRange | undefined {
  if (f.date_preset in PRESET_DAYS) return { last_days: PRESET_DAYS[f.date_preset] }
  if (f.date_preset === 'custom') return { start: f.start || undefined, end: f.end || undefined }
  return undefined
}

export function toDisplayFilters(f: DashboardFilters): DisplayFilters {
  const out: DisplayFilters = { activity_types: f.activity_types, date_range: toDateRange(f) }
  const sel = f.selection
  if (sel?.mode === 'only') out.activity_ids = sel.ids
  else if (sel?.ids.length) out.exclude_activity_ids = sel.ids
  return out
}

export const ALL_ACTIVITIES: ActivitySelection = { mode: 'all', ids: [] }

export function isSelected(sel: ActivitySelection | undefined, id: string): boolean {
  if (!sel) return true
  return sel.mode === 'only' ? sel.ids.includes(id) : !sel.ids.includes(id)
}

/** Check or uncheck several activities, keeping the selection's mode. */
export function setSelected(sel: ActivitySelection | undefined, ids: string[], selected: boolean): ActivitySelection {
  const cur = sel ?? ALL_ACTIVITIES
  // In "only" mode the list holds checked activities; in "all" mode, unchecked ones.
  const listed = cur.mode === 'only' ? selected : !selected
  const next = new Set(cur.ids)
  for (const id of ids) {
    if (listed) next.add(id)
    else next.delete(id)
  }
  return { mode: cur.mode, ids: [...next] }
}

export function toPanelQuery(p: PanelConfig): PanelQuery {
  return {
    id: p.id,
    group_by: p.group_by,
    lap_kind: p.lap_kind,
    include_partial_laps: p.include_partial_laps,
    x: p.x,
    y: p.y,
    error: p.error,
    series: p.series.map((s) => ({
      label: s.label,
      filters: [
        ...(s.distance_m ? [{ field: 'distance_m', op: 'near' as const, value: s.distance_m }] : []),
        ...(s.activity_type ? [{ field: 'activity_type', op: 'eq' as const, value: s.activity_type }] : []),
      ],
    })),
  }
}

export function toQueryRequest(d: Dashboard, settings: Settings): QueryRequest {
  return {
    filters: toDisplayFilters(d.filters),
    panels: d.panels.map(toPanelQuery),
    distance_tolerance: settings.distance_tolerance,
  }
}

/** True when the panel's y value combines several rows, so error bars mean something. */
export function yAggregates(p: Pick<PanelConfig, 'group_by' | 'y'>): boolean {
  if (p.group_by === 'point') return false
  return p.group_by !== 'activity' || p.y.level !== 'activity'
}

export function usesLaps(p: Pick<PanelConfig, 'x' | 'y' | 'group_by'>): boolean {
  return p.y.level === 'lap' || (p.group_by !== 'week' && p.group_by !== 'month' && p.x.level === 'lap')
}

export function blankPanel(y: number): PanelConfig {
  return {
    id: newId('p'),
    title: 'New panel',
    chart: 'line',
    group_by: 'activity',
    lap_kind: 'device',
    include_partial_laps: false,
    x: { field: 'start_time', level: 'activity' },
    y: { field: 'distance_m', level: 'activity', agg: 'mean' },
    error: 'none',
    series: [{ label: 'All', color_slot: 0 }],
    layout: { x: 0, y, w: 6, h: 7 },
  }
}

/** The first dashboard a new user sees: the examples the app was designed around. */
export function starterDashboard(): Dashboard {
  return {
    schema_version: SCHEMA_VERSION,
    id: newId('dash'),
    name: 'Running',
    filters: { activity_types: ['run'], date_preset: 'last_90' },
    panels: [
      {
        ...blankPanel(0),
        id: newId('p'),
        title: 'Pace per mile split',
        lap_kind: 'split_mi',
        y: { field: 'avg_pace_s_per_km', level: 'lap', agg: 'mean' },
        error: 'std',
        layout: { x: 0, y: 0, w: 6, h: 7 },
      },
      {
        ...blankPanel(0),
        id: newId('p'),
        title: 'Speed: 5k vs 10k runs',
        y: { field: 'speed', level: 'record', agg: 'mean' },
        error: 'std',
        series: [
          { label: '5k', color_slot: 0, distance_m: 5000 },
          { label: '10k', color_slot: 1, distance_m: 10000 },
        ],
        layout: { x: 6, y: 0, w: 6, h: 7 },
      },
      {
        ...blankPanel(0),
        id: newId('p'),
        title: 'Pace vs cadence',
        chart: 'scatter',
        x: { field: 'avg_cadence', level: 'activity' },
        y: { field: 'avg_pace_s_per_km', level: 'activity', agg: 'mean' },
        layout: { x: 0, y: 7, w: 6, h: 7 },
      },
      {
        ...blankPanel(0),
        id: newId('p'),
        title: 'Weekly distance',
        chart: 'bar',
        group_by: 'week',
        y: { field: 'distance_m', level: 'activity', agg: 'sum' },
        layout: { x: 6, y: 7, w: 6, h: 7 },
      },
    ],
  }
}
