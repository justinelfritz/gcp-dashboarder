// Dashboards and settings, persisted to localStorage, with validated JSON import/export.
import { useCallback, useEffect, useState } from 'react'
import { starterDashboard, upgradeStarterColors } from './model'
import { DEFAULT_SETTINGS, newId, PALETTE_SIZE, SCHEMA_VERSION } from './types'
import type { ActivitySelection, Dashboard, PanelConfig, SeriesConfig, Settings } from './types'

const DASHBOARDS_KEY = 'dashboarder.dashboards'
const SETTINGS_KEY = 'dashboarder.settings'

interface Saved {
  activeId: string
  dashboards: Dashboard[]
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable: changes last for this page load only.
  }
}

export class DashboardImportError extends Error {}

const LEVELS = ['activity', 'lap', 'record']
const CHARTS = ['line', 'scatter', 'bar']
const GROUPS = ['activity', 'week', 'month', 'point']
const LAP_KINDS = ['device', 'split_km', 'split_mi']
const ERRORS = ['none', 'std', 'sem']
const LINES = ['dash', 'dot', 'solid']
const AGGS = ['mean', 'median', 'min', 'max', 'sum', 'count', 'std']
const TYPES = ['run', 'ride', 'hike']
const DATE_PRESETS = ['last_30', 'last_60', 'last_90', 'last_180', 'last_365', 'all', 'custom']

function oneOf<T extends string>(value: unknown, allowed: string[], fallback: T, what: string): T {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new DashboardImportError(`${what}: unexpected value ${JSON.stringify(value)}`)
  }
  return value as T
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string, max = 200): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback
}

function axis(value: unknown, what: string) {
  const a = (value ?? {}) as Record<string, unknown>
  if (typeof a.field !== 'string' || !a.field) throw new DashboardImportError(`${what}: missing field`)
  return {
    field: a.field,
    level: oneOf(a.level, LEVELS, 'activity', `${what} level`),
    agg: oneOf(a.agg, AGGS, 'mean', `${what} aggregation`),
  }
}

function series(value: unknown, i: number): SeriesConfig {
  const s = (value ?? {}) as Record<string, unknown>
  const slot = Math.trunc(num(s.color_slot, i))
  const y2Slot = s.y2_color_slot == null ? null : Math.trunc(num(s.y2_color_slot, 0))
  const distance = num(s.distance_m, 0)
  const wrap = (k: number) => ((k % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE
  return {
    label: str(s.label, `Series ${i + 1}`, 60),
    color_slot: wrap(slot),
    ...(y2Slot == null ? {} : { y2_color_slot: wrap(y2Slot) }),
    distance_m: distance > 0 ? distance : null,
    ...(TYPES.includes(s.activity_type as string)
      ? { activity_type: s.activity_type as SeriesConfig['activity_type'] }
      : {}),
  }
}

function panel(value: unknown, i: number): PanelConfig {
  const p = (value ?? {}) as Record<string, unknown>
  const what = `panel ${i + 1}`
  const layout = (p.layout ?? {}) as Record<string, unknown>
  const rawSeries = Array.isArray(p.series) && p.series.length ? p.series.slice(0, PALETTE_SIZE) : [{}]
  return {
    id: newId('p'),
    title: str(p.title, `Panel ${i + 1}`, 120),
    chart: oneOf(p.chart, CHARTS, 'line', `${what} chart`),
    group_by: oneOf(p.group_by, GROUPS, 'activity', `${what} group_by`),
    lap_kind: oneOf(p.lap_kind, LAP_KINDS, 'device', `${what} lap_kind`),
    include_partial_laps: p.include_partial_laps === true,
    x: p.x === undefined ? { field: 'start_time', level: 'activity' } : axis(p.x, `${what} x axis`),
    y: axis(p.y, `${what} y axis`),
    ...(p.y2 == null ? {} : { y2: axis(p.y2, `${what} right axis`) }),
    ...(p.trend === true ? { trend: true } : {}),
    ...(p.y2_trend === true ? { y2_trend: true } : {}),
    ...(p.y2_line === undefined ? {} : { y2_line: oneOf(p.y2_line, LINES, 'dash', `${what} right axis line`) }),
    error: oneOf(p.error, ERRORS, 'none', `${what} error`),
    series: rawSeries.map(series),
    layout: {
      x: Math.max(0, Math.trunc(num(layout.x, 0))),
      y: Math.max(0, Math.trunc(num(layout.y, i * 7))),
      w: Math.min(12, Math.max(2, Math.trunc(num(layout.w, 6)))),
      h: Math.min(30, Math.max(3, Math.trunc(num(layout.h, 7)))),
    },
  }
}

function selection(value: unknown): ActivitySelection | undefined {
  if (value === undefined) return undefined
  const s = (value ?? {}) as Record<string, unknown>
  const ids = Array.isArray(s.ids) ? s.ids.filter((id): id is string => typeof id === 'string') : []
  return { mode: oneOf(s.mode, ['all', 'only'], 'all', 'selection mode'), ids: ids.slice(0, 10000) }
}

/** Validate an imported dashboard. Unknown keys are dropped; IDs are regenerated. */
export function parseDashboard(json: string): Dashboard {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json)
  } catch {
    throw new DashboardImportError('not valid JSON')
  }
  if (typeof data !== 'object' || data === null) throw new DashboardImportError('not a dashboard')
  if (data.schema_version !== SCHEMA_VERSION) {
    throw new DashboardImportError(`unsupported schema_version ${JSON.stringify(data.schema_version)}`)
  }
  const filters = (data.filters ?? {}) as Record<string, unknown>
  const types = Array.isArray(filters.activity_types)
    ? filters.activity_types.filter((t): t is 'run' | 'ride' | 'hike' => TYPES.includes(t as string))
    : ['run' as const]
  if (!Array.isArray(data.panels)) throw new DashboardImportError('missing panels')
  return {
    schema_version: SCHEMA_VERSION,
    id: newId('dash'),
    name: str(data.name, 'Imported dashboard', 80),
    filters: {
      activity_types: types.length ? types : ['run'],
      date_preset: oneOf(filters.date_preset, DATE_PRESETS, 'last_90', 'date preset'),
      start: typeof filters.start === 'string' ? filters.start : undefined,
      end: typeof filters.end === 'string' ? filters.end : undefined,
      ...(filters.selection !== undefined ? { selection: selection(filters.selection) } : {}),
    },
    panels: data.panels.slice(0, 24).map(panel),
  }
}

export function exportDashboard(d: Dashboard): string {
  return JSON.stringify(d, null, 2)
}

function loadSaved(): Saved {
  const saved = read<Saved>(DASHBOARDS_KEY)
  const valid = saved?.dashboards?.filter((d) => d?.schema_version === SCHEMA_VERSION) ?? []
  if (valid.length) {
    const activeId = valid.some((d) => d.id === saved?.activeId) ? saved!.activeId : valid[0].id
    return { activeId, dashboards: valid.map(upgradeStarterColors) }
  }
  const starter = starterDashboard()
  return { activeId: starter.id, dashboards: [starter] }
}

export function useDashboards() {
  const [saved, setSaved] = useState<Saved>(loadSaved)
  useEffect(() => write(DASHBOARDS_KEY, saved), [saved])

  const active = saved.dashboards.find((d) => d.id === saved.activeId) ?? saved.dashboards[0]

  const update = useCallback((next: Dashboard) => {
    setSaved((s) => ({ ...s, dashboards: s.dashboards.map((d) => (d.id === next.id ? next : d)) }))
  }, [])
  const add = useCallback((d: Dashboard) => {
    setSaved((s) => ({ activeId: d.id, dashboards: [...s.dashboards, d] }))
  }, [])
  const remove = useCallback((id: string) => {
    setSaved((s) => {
      const rest = s.dashboards.filter((d) => d.id !== id)
      const dashboards = rest.length ? rest : [starterDashboard()]
      return { activeId: dashboards[0].id, dashboards }
    })
  }, [])
  const select = useCallback((id: string) => setSaved((s) => ({ ...s, activeId: id })), [])

  return { dashboards: saved.dashboards, active, update, add, remove, select }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(read<Partial<Settings>>(SETTINGS_KEY) ?? {}),
  }))
  useEffect(() => write(SETTINGS_KEY, settings), [settings])
  return [settings, setSettings] as const
}
