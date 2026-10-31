import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// A signed-in user; the real hook needs Firebase.
vi.mock('./auth/useAuth', () => ({
  useAuth: () => ({
    state: { status: 'signed-in', user: { uid: 'alice', email: 'alice@example.com' } },
    notice: null,
    signOut: vi.fn(),
  }),
}))

const GUEST = 'g'.repeat(32)
const calls: { url: string; method: string; body?: string }[] = []

function mockApi(guestActivities: number) {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    if (url.endsWith('/health')) return Promise.resolve(Response.json({ status: 'ok' }))
    if (url.includes(`/sessions/${GUEST}/library`)) {
      return Promise.resolve(Response.json({ activities: guestActivities, visible_activities: guestActivities }))
    }
    if (url.endsWith('/me/claim-session')) {
      return Promise.resolve(Response.json({ activities_added: 3, duplicates_merged: 1, total_activities: 9 }))
    }
    if (url.includes('/activities')) return Promise.resolve(Response.json({ total: 0, items: [] }))
    return Promise.resolve(Response.json({ activities: 0, visible_activities: 0, files_stored: 0, bytes_stored: 0 }))
  }))
}

describe('App, signed in', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('reads the account\'s data and offers to claim guest uploads', async () => {
    localStorage.setItem('dashboarder.session_id', GUEST)
    mockApi(4)
    render(<App />)
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument()
    expect(await screen.findByText(/4 activities uploaded before you signed in/)).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.url.includes('/me/activities'))).toBe(true))
    // No new guest session is created for a signed-in user.
    expect(calls.some((c) => c.url.endsWith('/sessions') && c.method === 'POST')).toBe(false)

    fireEvent.click(screen.getByText('Add to my account'))
    expect(await screen.findByText('Added 3 activities to your account (1 were already there).')).toBeInTheDocument()
    const claim = calls.find((c) => c.url.endsWith('/me/claim-session'))!
    expect(JSON.parse(claim.body!)).toEqual({ session_id: GUEST })
    expect(localStorage.getItem('dashboarder.session_id')).toBeNull()
  })

  it('quietly forgets an empty guest session', async () => {
    localStorage.setItem('dashboarder.session_id', GUEST)
    mockApi(0)
    render(<App />)
    await screen.findByText('alice@example.com')
    await waitFor(() => expect(localStorage.getItem('dashboarder.session_id')).toBeNull())
    expect(screen.queryByText(/before you signed in/)).not.toBeInTheDocument()
  })
})
