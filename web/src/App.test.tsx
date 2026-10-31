import { render, screen } from '@testing-library/react'
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
    expect(localStorage.getItem('dashboarder.session_id')).toBe('abcdefgh12345678')
  })

  it('shows unavailable when the API fails', async () => {
    mockFetch(() => new Response(null, { status: 503 }))
    render(<App />)
    expect(await screen.findByText('API unavailable')).toBeInTheDocument()
  })
})
