import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(handler(url))))
}

describe('App', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('shows connected and stores a session when the API is healthy', async () => {
    mockFetch((url) =>
      url.endsWith('/health')
        ? Response.json({ status: 'ok' })
        : url.includes('/activities')
          ? Response.json({ total: 0, items: [] })
          : Response.json({ session_id: 'abcdefgh12345678' }, { status: 201 }),
    )
    render(<App />)
    expect(await screen.findByText('API connected')).toBeInTheDocument()
    // The guest session is created once the API is up (and sign-in state is known).
    await waitFor(() => expect(localStorage.getItem('dashboarder.session_id')).toBe('abcdefgh12345678'))
  })

  it('keeps individual activity mode and the open activity across tabs', async () => {
    const activity = (id: string, name: string, day: number) => ({
      activity_id: id, name, activity_type: 'run', activity_subtype: 'standard', raw_activity_type: 'running',
      source_format: 'fit', start_time: `2026-09-0${day}T12:00:00Z`, tz_offset_min: 0, distance_m: 5000,
      duration_s: 1500, moving_time_s: 1500, avg_speed_mps: 3.3, elevation_gain_m: 20, avg_hr: 150,
      avg_cadence: 170, avg_power_w: null, has_records: true,
    })
    mockFetch((url) => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' })
      if (url.endsWith('/sessions')) return Response.json({ session_id: 'abcdefgh12345678' }, { status: 201 })
      if (url.includes('/activities')) return Response.json({ total: 2, items: [activity('a2', 'Tempo', 6), activity('a1', 'Easy', 5)] })
      if (url.includes('/fields')) return Response.json({ total_activities: 2, levels: { activity: [], lap: [], record: [] } })
      if (url.includes('/query')) return Response.json({ panels: [] })
      return Response.json({ activities: 2, visible_activities: 2, first_date: '2026-09-05', last_date: '2026-09-06', files_stored: 2, bytes_stored: 2048 })
    })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Individual activity' }))
    expect(await screen.findByRole('heading', { name: 'Tempo' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '← Older' }))
    expect(await screen.findByRole('heading', { name: 'Easy' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load Data' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Dashboard' }))
    expect(await screen.findByRole('heading', { name: 'Easy' })).toBeInTheDocument()
    expect(localStorage.getItem('dashboarder.mode')).toBe('"activity"')
  })

  it('shows unavailable when the API fails', async () => {
    mockFetch(() => new Response(null, { status: 503 }))
    render(<App />)
    expect(await screen.findByText('API unavailable')).toBeInTheDocument()
  })
})

describe('API client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the signed-in user\'s token', async () => {
    const { api, setAuthTokenGetter } = await import('./api/client')
    const fetch = vi.fn(async () => Response.json({ status: 'ok' }))
    vi.stubGlobal('fetch', fetch)
    setAuthTokenGetter(async () => 'tok-123')
    await api.health()
    setAuthTokenGetter(async () => null)
    await api.health()
    const headers = (call: number) => (fetch.mock.calls[call] as unknown as [string, RequestInit])[1].headers as Headers
    expect(headers(0).get('Authorization')).toBe('Bearer tok-123')
    expect(headers(1).has('Authorization')).toBe(false)
  })
})
