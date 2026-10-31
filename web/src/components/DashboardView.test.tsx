import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldCatalog, QueryRequest, QueryResponse } from '../api/client'
import { useDashboards } from '../dashboard/store'
import { DEFAULT_SETTINGS } from '../dashboard/types'
import type { Settings } from '../dashboard/types'
import DashboardView from './DashboardView'

const query = vi.fn()

vi.mock('../api/client', () => ({
  api: {
    query: (...args: unknown[]) => query(...args),
    fields: async (): Promise<FieldCatalog> => ({
      total_activities: 10,
      levels: {
        activity: [
          { name: 'start_time', label: 'Date', unit: 'datetime', kind: 'datetime', coverage: 10 },
          { name: 'distance_m', label: 'Distance', unit: 'm', kind: 'number', coverage: 10 },
          { name: 'avg_hr', label: 'Average heart rate', unit: 'bpm', kind: 'number', coverage: 10 },
          { name: 'avg_power_w', label: 'Average power', unit: 'W', kind: 'number', coverage: 0 },
        ],
        lap: [{ name: 'avg_pace_s_per_km', label: 'Lap pace', unit: 's/km', kind: 'number', coverage: 2 }],
        record: [{ name: 'speed', label: 'Speed', unit: 'm/s', kind: 'number', coverage: 2 }],
      },
    }),
    activities: async () => ({
      total: 3,
      items: ['a3', 'a2', 'a1'].map((id, i) => ({
        activity_id: id,
        name: `Run ${3 - i}`,
        activity_type: 'run',
        start_time: `2026-09-0${7 - i}T12:00:00Z`,
        tz_offset_min: -240,
        distance_m: 5000,
        moving_time_s: 1500,
      })),
    }),
  },
}))

// Plotly can't render in jsdom; the figure building it consumes is tested separately.
vi.mock('../charts/PlotlyChart', () => ({
  default: ({ label }: { label: string }) => <div data-testid="chart">{label}</div>,
}))

function respond(req: QueryRequest): QueryResponse {
  return {
    panels: req.panels.map((p) => ({
      id: p.id,
      x: { field: 'start_time', label: 'Date', unit: 'datetime', kind: 'datetime' },
      y: { field: p.y.field, label: p.y.field === 'distance_m' ? 'Distance' : 'Value', unit: p.y.field === 'distance_m' ? 'm' : 's/km', kind: 'number' },
      series: (p.series ?? [{ label: 'All' }]).map((s) => ({
        label: s.label ?? 'All',
        color: null,
        n_activities: 1,
        points: [{ x: '2026-09-05T08:00:00', y: 5000, error: null, n: 1, activity_id: 'a1' }],
      })),
      warnings: [],
      error: null,
    })),
  }
}

function Harness({ initial = DEFAULT_SETTINGS }: { initial?: Settings }) {
  const store = useDashboards()
  const [settings, setSettings] = useState(initial)
  return <DashboardView sessionId="s" store={store} settings={settings} onSettings={setSettings} refreshKey={0} />
}

describe('DashboardView', () => {
  beforeEach(() => {
    localStorage.clear()
    query.mockImplementation(async (_sid: string, req: QueryRequest) => respond(req))
  })
  afterEach(() => vi.clearAllMocks())

  it('fetches every panel of the starter dashboard in one request', async () => {
    render(<Harness />)
    expect(await screen.findAllByTestId('chart')).toHaveLength(4)
    expect(query).toHaveBeenCalledTimes(1)
    const req = query.mock.calls[0][1] as QueryRequest
    expect(req.panels).toHaveLength(4)
    expect(req.filters?.activity_types).toEqual(['run'])
  })

  it('shows a panel as a table in display units', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    const panel = screen.getByRole('heading', { name: 'Weekly distance' }).closest('article')!
    fireEvent.click(within(panel).getByText('Table'))
    expect(within(panel).getByRole('table')).toBeInTheDocument()
    expect(within(panel).getByText('3.11')).toBeInTheDocument() // 5000 m in miles
  })

  it('adds a panel through the editor, with zero-coverage fields disabled', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    fireEvent.click(screen.getByText('Add panel'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByDisplayValue('New panel'), { target: { value: 'Heart rate' } })
    const yField = within(dialog).getByLabelText('Y axis field')
    await waitFor(() => expect(within(yField).getByText('Average power (0/10)')).toBeDisabled())
    fireEvent.change(yField, { target: { value: 'avg_hr' } })
    fireEvent.click(within(dialog).getByText('Save'))

    expect(await screen.findByText('Heart rate')).toBeInTheDocument()
    await waitFor(() => {
      const last = query.mock.calls[query.mock.calls.length - 1][1] as QueryRequest
      expect(last.panels.map((p) => p.y.field)).toContain('avg_hr')
    })
  })

  it('adds a right-axis quantity, fetched in the same request', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    const panel = screen.getByRole('heading', { name: 'Weekly distance' }).closest('article')!
    fireEvent.click(within(panel).getByText('Edit'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('Plot a second quantity'))
    fireEvent.change(await within(dialog).findByLabelText('Right axis field'), { target: { value: 'avg_hr' } })
    fireEvent.change(within(dialog).getByLabelText('Right axis line style'), { target: { value: 'dot' } })
    const colors = within(dialog).getByRole('radiogroup', { name: 'Right axis color for All' })
    fireEvent.click(within(colors).getByRole('radio', { name: 'Color 3' }))
    expect(within(colors).getByRole('radio', { name: 'Color 3' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(within(dialog).getByText('Save'))

    await waitFor(() => {
      const last = query.mock.calls[query.mock.calls.length - 1][1] as QueryRequest
      const companion = last.panels.find((p) => p.id.endsWith('~y2'))
      expect(companion?.y).toMatchObject({ field: 'avg_hr', level: 'activity' })
      expect(companion?.group_by).toBe('week')
    })
    expect(within(panel).getByTestId('chart')).toBeInTheDocument()
  })

  it('refetches for a new distance tolerance but not for a units change', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    fireEvent.change(screen.getByDisplayValue('Imperial'), { target: { value: 'metric' } })
    await new Promise((r) => setTimeout(r, 400))
    expect(query).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByDisplayValue('2.5'), { target: { value: '5' } })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    expect((query.mock.calls[1][1] as QueryRequest).distance_tolerance).toBe(0.05)
  })

  it('picks activities by checkbox, date range, and shift-click', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    fireEvent.click(await screen.findByText('All 3 activities'))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByLabelText('Include Run 2'))
    expect(within(dialog).getByText('2 of 3 selected')).toBeInTheDocument()

    // Narrow to one day, uncheck what is shown, then widen again.
    fireEvent.change(within(dialog).getByLabelText('Show from'), { target: { value: '2026-09-07' } })
    fireEvent.click(within(dialog).getByText('Uncheck shown (1)'))
    fireEvent.click(within(dialog).getByText('Show all'))
    expect(within(dialog).getByText('1 of 3 selected')).toBeInTheDocument()

    // Start from nothing and shift-click a range.
    fireEvent.click(within(dialog).getByText('Pick individually'))
    fireEvent.click(within(dialog).getByLabelText('Include Run 3'))
    fireEvent.click(within(dialog).getByLabelText('Include Run 1'), { shiftKey: true })
    expect(within(dialog).getByText('3 of 3 selected')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByLabelText('Include Run 2'))
    fireEvent.click(within(dialog).getByText('Apply'))

    expect(await screen.findByText('2 of 3 activities')).toBeInTheDocument()
    await waitFor(() => {
      const last = query.mock.calls[query.mock.calls.length - 1][1] as QueryRequest
      expect(last.filters?.activity_ids?.sort()).toEqual(['a1', 'a3'])
    })
  })
})
