import { render, screen, waitFor } from '@testing-library/react'
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
