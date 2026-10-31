import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { starterDashboard } from './model'
import { toAccountDocument } from './store'
import type { Saved } from './store'
import { useAccountSync } from './sync'
import { DEFAULT_SETTINGS } from './types'
import type { Settings } from './types'

const getDashboards = vi.fn()
const saveDashboards = vi.fn()
vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: { getDashboards: () => getDashboards(), saveDashboards: (d: unknown, g: number) => saveDashboards(d, g) },
}))

function board(name: string): Saved {
  const d = { ...starterDashboard(), name }
  return { activeId: d.id, dashboards: [d] }
}

/** The hook wired to real state, as App wires it to the dashboard and settings stores. */
function setup(local: Saved, initialSettings: Settings = DEFAULT_SETTINGS) {
  const replace = vi.fn()
  const setSettings = vi.fn()
  const hook = renderHook(() => {
    const [saved, setSaved] = useState(local)
    const [settings, setS] = useState(initialSettings)
    const sync = useAccountSync('alice', saved, settings,
      (x) => { replace(x); setSaved(x) }, (x) => { setSettings(x); setS(x) })
    return { ...sync, setSaved }
  })
  return { ...hook, replace, setSettings }
}

describe('useAccountSync', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('shows the account copy on sign-in, without saving it straight back', async () => {
    const server = board('From another device')
    getDashboards.mockResolvedValue({ document: toAccountDocument(server, { units: 'metric', distance_tolerance: 0.05 }), generation: 7 })
    const { result, replace, setSettings } = setup(board('Local'))
    await waitFor(() => expect(result.current.status).toBe('saved'))
    expect(replace.mock.calls[0][0].dashboards[0].name).toBe('From another device')
    expect(setSettings).toHaveBeenCalledWith({ units: 'metric', distance_tolerance: 0.05 })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(saveDashboards).not.toHaveBeenCalled()
  })

  it('uploads this browser\'s copy the first time, then saves later changes on top of it', async () => {
    getDashboards.mockResolvedValue({ document: null, generation: 0 })
    saveDashboards.mockResolvedValueOnce({ generation: 1 }).mockResolvedValueOnce({ generation: 2 })
    const local = board('Local')
    const { result } = setup(local)
    await waitFor(() => expect(saveDashboards).toHaveBeenCalledTimes(1))
    expect(saveDashboards.mock.calls[0][1]).toBe(0)
    await waitFor(() => expect(result.current.status).toBe('saved'))

    act(() => result.current.setSaved(board('Edited')))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    await waitFor(() => expect(saveDashboards).toHaveBeenCalledTimes(2))
    expect(saveDashboards.mock.calls[1][1]).toBe(1)
  })

  it('shows the other device\'s version when a save conflicts', async () => {
    getDashboards.mockResolvedValue({ document: null, generation: 0 })
    const newer = board('Saved elsewhere')
    saveDashboards.mockRejectedValue(new ApiError('conflict', 409, { document: toAccountDocument(newer, DEFAULT_SETTINGS), generation: 5 }))
    const { result, replace } = setup(board('Local'))
    await waitFor(() => expect(result.current.notice).toMatch(/changed on another device/))
    expect(replace.mock.calls[replace.mock.calls.length - 1][0].dashboards[0].name).toBe('Saved elsewhere')
  })

  it('keeps working locally when saving fails', async () => {
    getDashboards.mockResolvedValue({ document: null, generation: 0 })
    saveDashboards.mockRejectedValue(new Error('offline'))
    const { result } = setup(board('Local'))
    await waitFor(() => expect(result.current.status).toBe('offline'))
  })
})
