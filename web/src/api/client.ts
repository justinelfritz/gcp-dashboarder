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
  /** The same bytes were processed by an earlier upload, so the file was skipped. */
  already_stored?: boolean
}

export interface UploadCheckResponse {
  /** Hashes this session has already processed. */
  known: string[]
}

export interface LibrarySummary {
  /** Every stored activity, including hidden types. */
  activities: number
  /** Outdoor runs, rides, and hikes. */
  visible_activities: number
  /** Local calendar dates (YYYY-MM-DD) of the earliest and latest stored activities. */
  first_date: string | null
  last_date: string | null
  files_stored: number
  bytes_stored: number
}

/** The API checks at most this many hashes per request. */
export const MAX_CHECK_HASHES = 10_000

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

export interface ClaimResponse {
  activities_added: number
  duplicates_merged: number
  total_activities: number
}

/** Where a user's data lives in the API: `/me` when signed in, `/sessions/{id}` for a guest. */
export type Scope = string

export const guestScope = (sessionId: string): Scope => `/sessions/${sessionId}`
export const USER_SCOPE: Scope = '/me'

// Supplies the signed-in user's ID token (refreshed as needed), or null when signed out.
let tokenGetter: () => Promise<string | null> = async () => null

export function setAuthTokenGetter(getter: () => Promise<string | null>): void {
  tokenGetter = getter
}

export interface DashboardsDocument {
  /** Dashboards and settings as the web app saved them; null before the first save. */
  document: Record<string, unknown> | null
  generation: number
}

export interface DeleteResponse {
  objects_deleted: number
}

/** A failed API call, with its status and parsed body (e.g. the current copy on a 409). */
export class ApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await tokenGetter()
  const headers = new Headers(init?.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const resp = await fetch(`${BASE_URL}${path}`, { ...init, headers })
  if (!resp.ok) {
    const body = await resp.json().catch(() => null)
    throw new ApiError(`${init?.method ?? 'GET'} ${path} failed: ${resp.status}`, resp.status, body)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  health: () => request<HealthResponse>('/health'),
  createSession: () => request<SessionResponse>('/sessions', { method: 'POST' }),
  upload: (scope: string, files: File[], options: UploadOptions = {}) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    if (options.timezone) form.append('timezone', options.timezone)
    if (options.units) form.append('units', options.units)
    return request<UploadResponse>(`${scope}/uploads`, { method: 'POST', body: form })
  },
  checkUploads: (scope: string, hashes: string[]) =>
    request<UploadCheckResponse>(`${scope}/uploads/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes }),
    }),
  library: (scope: string) => request<LibrarySummary>(`${scope}/library`),
  activities: (scope: string, params: ActivityListParams = {}) => {
    const qs = new URLSearchParams()
    params.activity_type?.forEach((t) => qs.append('activity_type', t))
    if (params.last_days) qs.set('last_days', String(params.last_days))
    if (params.start) qs.set('start', params.start)
    if (params.end) qs.set('end', params.end)
    if (params.limit) qs.set('limit', String(params.limit))
    return request<ActivityList>(`${scope}/activities?${qs}`)
  },
  fields: (scope: string, activityTypes: ActivityType[] = []) => {
    const qs = new URLSearchParams()
    activityTypes.forEach((t) => qs.append('activity_type', t))
    return request<FieldCatalog>(`${scope}/fields?${qs}`)
  },
  deleteActivity: (scope: Scope, activityId: string) =>
    request<void>(`${scope}/activities/${activityId}`, { method: 'DELETE' }),
  /** Deletes everything stored for the scope; for `/me`, the account too. */
  deleteAll: (scope: Scope) => request<DeleteResponse>(scope, { method: 'DELETE' }),
  getDashboards: () => request<DashboardsDocument>('/me/dashboards'),
  /** Throws ApiError 409 (body: the current DashboardsDocument) if another device saved first. */
  saveDashboards: (document: Record<string, unknown>, baseGeneration: number) =>
    request<{ generation: number }>('/me/dashboards', json('PUT', { document, base_generation: baseGeneration })),
  claimSession: (sessionId: string) =>
    request<ClaimResponse>('/me/claim-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }),
  query: (scope: string, body: QueryRequest) =>
    request<QueryResponse>(`${scope}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}
