// Translating dashboard definitions into API queries, plus starter content.
import type { ActivityType, DateRange, DisplayFilters, PanelQuery, QueryRequest } from '../api/client'
import { newId, PALETTE_SIZE, SCHEMA_VERSION } from './types'
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

/**
 * Palette slots for the right-axis lines. A series' own pick wins; otherwise it takes a slot the
 * left series don't use, in palette order, so the two axes never share a hue by default.
 */
export function y2Slots(p: Pick<PanelConfig, 'series'>): number[] {
  const used = new Set(p.series.map((s) => s.color_slot % PALETTE_SIZE))
  const free = [...Array(PALETTE_SIZE).keys()].filter((k) => !used.has(k))
  return p.series.map((s, i) =>
    s.y2_color_slot ?? (free.length ? free[i % free.length] : (s.color_slot + 1) % PALETTE_SIZE))
}

/** Id suffix of the companion query that fetches a panel's right-axis quantity. */
export const Y2_SUFFIX = '~y2'

export function toQueryRequest(d: Dashboard, settings: Settings): QueryRequest {
  return {
    filters: toDisplayFilters(d.filters),
    // The right-axis quantity is its own query: the same panel with y swapped, so the API needs no
    // notion of a second axis.
    panels: d.panels.flatMap((p) => {
      const q = toPanelQuery(p)
      return p.y2 ? [q, { ...q, id: p.id + Y2_SUFFIX, y: p.y2 }] : [q]
    }),
    distance_tolerance: settings.distance_tolerance,
  }
}

/** True when the panel's y value combines several rows, so error bars mean something. */
export function yAggregates(p: Pick<PanelConfig, 'group_by' | 'y'>): boolean {
  if (p.group_by === 'point') return false
  return p.group_by !== 'activity' || p.y.level !== 'activity'
}

export function usesLaps(p: Pick<PanelConfig, 'x' | 'y' | 'y2' | 'group_by'>): boolean {
  if (p.y.level === 'lap' || p.y2?.level === 'lap') return true
  return p.group_by !== 'week' && p.group_by !== 'month' && p.x.level === 'lap'
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
        series: [{ label: 'All', color_slot: 0 }],
        layout: { x: 0, y: 0, w: 6, h: 7 },
      },
      {
        ...blankPanel(0),
        id: newId('p'),
        title: speedTitle(['run']),
        y: { field: 'speed', level: 'record', agg: 'mean' },
        error: 'std',
        series: [
          { label: '5k', color_slot: 1, distance_m: 5000 },
          { label: '10k', color_slot: 2, distance_m: 10000 },
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
        series: [{ label: 'All', color_slot: 6 }],
        layout: { x: 0, y: 7, w: 6, h: 7 },
      },
      {
        ...blankPanel(0),
        id: newId('p'),
        title: 'Weekly distance',
        chart: 'bar',
        group_by: 'week',
        y: { field: 'distance_m', level: 'activity', agg: 'sum' },
        series: [{ label: 'All', color_slot: 7 }],
        layout: { x: 6, y: 7, w: 6, h: 7 },
      },
    ],
  }
}

const SPORT_PLURALS: Record<ActivityType, string> = { run: 'runs', ride: 'rides', hike: 'hikes' }
const SPEED_TITLE = /^Speed: 5k vs 10k (runs|rides|hikes|activities)$/

/** The starter speed panel's title for the selected sports: "runs" for one sport, "activities" for several. */
export function speedTitle(types: ActivityType[]): string {
  return `Speed: 5k vs 10k ${types.length === 1 ? SPORT_PLURALS[types[0]] : 'activities'}`
}

/** Retitles the starter speed panel to match the sports; titles the user has edited are left alone. */
export function retitleForTypes(panels: PanelConfig[], types: ActivityType[]): PanelConfig[] {
  return panels.map((p) => (SPEED_TITLE.test(p.title) ? { ...p, title: speedTitle(types) } : p))
}

/** Colors the starter panels shipped with before each got its own (all slot 0, 5k/10k slots 0/1). */
const OLD_STARTER_SLOTS: Record<string, number[]> = {
  'Pace per mile split': [0],
  'Pace vs cadence': [0],
  'Weekly distance': [0],
  speed: [0, 1],
}

/** Gives saved starter panels the current starter colors, unless the user changed their title or colors. */
export function upgradeStarterColors(d: Dashboard): Dashboard {
  const current = new Map(starterDashboard().panels.map((p) => [SPEED_TITLE.test(p.title) ? 'speed' : p.title, p.series]))
  const panels = d.panels.map((p) => {
    const key = SPEED_TITLE.test(p.title) ? 'speed' : p.title
    const old = OLD_STARTER_SLOTS[key]
    const next = current.get(key)
    const slots = p.series.map((s) => s.color_slot)
    if (!old || !next || slots.length !== old.length || slots.some((s, i) => s !== old[i])) return p
    if (next.every((s, i) => s.color_slot === old[i])) return p
    return { ...p, series: p.series.map((s, i) => ({ ...s, color_slot: next[i].color_slot })) }
  })
  return panels.every((p, i) => p === d.panels[i]) ? d : { ...d, panels }
}
