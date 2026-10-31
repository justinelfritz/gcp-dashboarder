// Typed client for the Dashboarder API. Keep these types in sync with api/app/models.py.

export interface HealthResponse {
  status: string
}

export interface SessionResponse {
  session_id: string
}

export interface RowIssue {
  row: number | null
  reason: string
}

export type SourceFormat = 'fit' | 'garmin_csv' | 'strava_csv'

export interface FileReport {
  filename: string
  detected_format: SourceFormat | null
  size_bytes: number
  activities_parsed: number
  activities_added: number
  duplicates_merged: number
  rows_rejected: number
  rejections: RowIssue[]
  warnings: string[]
}

export interface UploadResponse {
  upload_id: string
  files: FileReport[]
  total_activities: number
}

export interface UploadOptions {
  /** IANA timezone used to read Garmin CSV local times. */
  timezone?: string
  /** Unit system of Garmin CSV values. */
  units?: 'metric' | 'imperial'
}

// ---- Activities and field catalog ----

export type ActivityType = 'run' | 'ride' | 'hike'
export type Level = 'activity' | 'lap' | 'record'

export interface ActivitySummary {
  activity_id: string
  name: string | null
  activity_type: ActivityType
  raw_activity_type: string | null
  source_format: SourceFormat
  start_time: string
  tz_offset_min: number | null
  distance_m: number | null
  duration_s: number | null
  moving_time_s: number | null
  avg_speed_mps: number | null
  elevation_gain_m: number | null
  avg_hr: number | null
  avg_cadence: number | null
  avg_power_w: number | null
  has_records: boolean
}

export interface ActivityList {
  total: number
  items: ActivitySummary[]
}

export interface ActivityListParams {
  activity_type?: ActivityType[]
  /** Same meaning as a query's date_range: local dates, inclusive. */
  last_days?: number
  start?: string
  end?: string
  /** At most 5000. */
  limit?: number
}

export interface FieldInfo {
  name: string
  label: string
  /** Metric unit. "cadence" means steps/min for runs and hikes, rpm for rides. */
  unit: string
  kind: 'number' | 'datetime' | 'category'
  /** Activities in the selection that have data for this field. */
  coverage: number
}

export interface FieldCatalog {
  total_activities: number
  levels: Record<Level, FieldInfo[]>
}

// ---- Panel queries ----

export interface FieldFilter {
  /** An activity-level field. */
  field: string
  op: 'eq' | 'neq' | 'in' | 'between' | 'gte' | 'lte' | 'near'
  value: unknown
  /** For "near": accept value × (1 ± tolerance). Defaults to the request's distance_tolerance. */
  tolerance?: number
}

export interface DateRange {
  last_days?: number
  start?: string
  /** Inclusive. */
  end?: string
}

export interface DisplayFilters {
  activity_types?: ActivityType[]
  date_range?: DateRange
  filters?: FieldFilter[]
  /** Analyze only these activities. */
  activity_ids?: string[]
  /** Analyze everything that matches except these. */
  exclude_activity_ids?: string[]
}

export type Aggregation = 'mean' | 'median' | 'min' | 'max' | 'sum' | 'count' | 'std'

export interface AxisSpec {
  field: string
  level?: Level
  agg?: Aggregation
}

export interface SeriesSpec {
  label?: string
  color?: string
  filters?: FieldFilter[]
}

export interface PanelQuery {
  id: string
  group_by?: 'activity' | 'week' | 'month' | 'point'
  lap_kind?: 'device' | 'split_km' | 'split_mi'
  include_partial_laps?: boolean
  x?: AxisSpec
  y: AxisSpec
  error?: 'none' | 'std' | 'sem'
  filters?: FieldFilter[]
  series?: SeriesSpec[]
}

export interface QueryRequest {
  filters?: DisplayFilters
  panels: PanelQuery[]
  /** Default ± fraction for "near" distance filters (0.025 = ±2.5%). */
  distance_tolerance?: number
}

export interface Point {
  x: number | string
  y: number
  error: number | null
  n: number
  activity_id: string | null
}

export interface AxisInfo {
  field: string
  label: string
  unit: string
  kind: string
}

export interface SeriesResult {
  label: string
  color: string | null
  n_activities: number
  points: Point[]
}

export interface PanelResult {
  id: string
  x: AxisInfo | null
  y: AxisInfo | null
  series: SeriesResult[]
  warnings: string[]
  error: string | null
}

export interface QueryResponse {
  panels: PanelResult[]
}

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, init)
  if (!resp.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${resp.status}`)
  }
  return (await resp.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  createSession: () => request<SessionResponse>('/sessions', { method: 'POST' }),
  upload: (sessionId: string, files: File[], options: UploadOptions = {}) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    if (options.timezone) form.append('timezone', options.timezone)
    if (options.units) form.append('units', options.units)
    return request<UploadResponse>(`/sessions/${sessionId}/uploads`, { method: 'POST', body: form })
  },
  activities: (sessionId: string, params: ActivityListParams = {}) => {
    const qs = new URLSearchParams()
    params.activity_type?.forEach((t) => qs.append('activity_type', t))
    if (params.last_days) qs.set('last_days', String(params.last_days))
    if (params.start) qs.set('start', params.start)
    if (params.end) qs.set('end', params.end)
    if (params.limit) qs.set('limit', String(params.limit))
    return request<ActivityList>(`/sessions/${sessionId}/activities?${qs}`)
  },
  fields: (sessionId: string, activityTypes: ActivityType[] = []) => {
    const qs = new URLSearchParams()
    activityTypes.forEach((t) => qs.append('activity_type', t))
    return request<FieldCatalog>(`/sessions/${sessionId}/fields?${qs}`)
  },
  query: (sessionId: string, body: QueryRequest) =>
    request<QueryResponse>(`/sessions/${sessionId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}
