// Dashboard definitions, stored in localStorage and exported/imported as JSON.
// Bump SCHEMA_VERSION (and migrate in store.ts) whenever this shape changes.
import type { ActivityType, Aggregation, AxisSpec, PanelQuery } from '../api/client'

export const SCHEMA_VERSION = 1

export type ChartType = 'line' | 'scatter' | 'bar'
export type DatePreset = 'last_30' | 'last_60' | 'last_90' | 'last_180' | 'last_365' | 'all' | 'custom'

export interface DashboardFilters {
  activity_types: ActivityType[]
  date_preset: DatePreset
  /** Local dates (YYYY-MM-DD), used when date_preset is "custom". */
  start?: string
  end?: string
  /** Hand-picked activities; absent means every activity that matches the filters. */
  selection?: ActivitySelection
}

/**
 * "all": analyze every matching activity except `ids` (new uploads are included).
 * "only": analyze just `ids` (new uploads are not).
 */
export interface ActivitySelection {
  mode: 'all' | 'only'
  ids: string[]
}

export interface SeriesConfig {
  label: string
  /** Index into the categorical palette (0-7); colors follow the series, never its rank. */
  color_slot: number
  /** Target activity distance in meters; matches within ± the distance tolerance setting. */
  distance_m?: number | null
  /** Limit this series to one sport, e.g. runs vs rides on one panel. */
  activity_type?: ActivityType | null
}

export interface PanelLayout {
  x: number
  y: number
  w: number
  h: number
}

export interface PanelConfig {
  id: string
  title: string
  chart: ChartType
  group_by: NonNullable<PanelQuery['group_by']>
  lap_kind: NonNullable<PanelQuery['lap_kind']>
  include_partial_laps: boolean
  x: AxisSpec
  y: AxisSpec
  error: NonNullable<PanelQuery['error']>
  series: SeriesConfig[]
  layout: PanelLayout
}

export interface Dashboard {
  schema_version: typeof SCHEMA_VERSION
  id: string
  name: string
  filters: DashboardFilters
  panels: PanelConfig[]
}

export interface Settings {
  units: 'imperial' | 'metric'
  /** ± fraction for distance bins (0.025 = ±2.5%). */
  distance_tolerance: number
}

export const DEFAULT_SETTINGS: Settings = { units: 'imperial', distance_tolerance: 0.025 }

export const PALETTE_SIZE = 8

export const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'mean', label: 'Mean' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'sum', label: 'Sum' },
  { value: 'count', label: 'Count' },
  { value: 'std', label: 'Std dev' },
]

export const DISTANCE_PRESETS: { label: string; meters: number }[] = [
  { label: '1 mile', meters: 1609.344 },
  { label: '5k', meters: 5000 },
  { label: '10k', meters: 10000 },
  { label: 'Half marathon', meters: 21097.5 },
  { label: 'Marathon', meters: 42195 },
  { label: '20 km', meters: 20000 },
  { label: '40 km', meters: 40000 },
  { label: '100 km', meters: 100000 },
  { label: '100 miles', meters: 160934.4 },
]

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}
