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

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE_URL}${path}`, init)
  if (!resp.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${resp.status}`)
  }
  return (await resp.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/healthz'),
  createSession: () => request<SessionResponse>('/sessions', { method: 'POST' }),
  upload: (sessionId: string, files: File[], options: UploadOptions = {}) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f))
    if (options.timezone) form.append('timezone', options.timezone)
    if (options.units) form.append('units', options.units)
    return request<UploadResponse>(`/sessions/${sessionId}/uploads`, { method: 'POST', body: form })
  },
}
