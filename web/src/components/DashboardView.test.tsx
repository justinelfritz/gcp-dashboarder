import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FieldCatalog, QueryRequest, QueryResponse } from '../api/client'
import { useDashboardMode, useDashboards } from '../dashboard/store'
import { DEFAULT_SETTINGS } from '../dashboard/types'
import type { Settings } from '../dashboard/types'
import DashboardView from './DashboardView'

const query = vi.fn()
const deleteActivity = vi.fn<(scope: string, id: string) => Promise<void>>(async () => {})

vi.mock('../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/client')>()),
  api: {
    query: (...args: unknown[]) => query(...args),
    deleteActivity: (scope: string, id: string) => deleteActivity(scope, id),
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
      subtypes: { run: { trail: 2, standard: 1 } },
    }),
    activities: async () => ({
      total: 3,
      items: ['a3', 'a2', 'a1'].map((id, i) => ({
        activity_id: id,
        name: `Run ${3 - i}`,
        activity_type: 'run',
        activity_subtype: i === 2 ? 'standard' : 'trail',
        start_time: `2026-09-0${7 - i}T12:00:00Z`,
        tz_offset_min: -240,
        distance_m: 5000,
        moving_time_s: 1500,
        duration_s: 1560,
        avg_hr: 150 + i,
        has_records: id !== 'a1',
      })),
    }),
  },
}))

// Plotly can't render in jsdom; the figure building it consumes is tested separately.
vi.mock('../charts/PlotlyChart', () => ({
  default: ({ label, onOpenActivity }: { label: string; onOpenActivity?: (id: string) => void }) => (
    <div data-testid="chart">
      {label}
      {onOpenActivity && <button type="button" onClick={() => onOpenActivity('a2')}>Open a2 from {label}</button>}
    </div>
  ),
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
  const [mode, setMode] = useDashboardMode()
  const [activityId, setActivityId] = useState<string | null>(null)
  return (
    <DashboardView scope="/sessions/s" store={store} settings={settings} onSettings={setSettings} refreshKey={0}
      mode={mode} onMode={setMode} activityId={activityId} onActivity={setActivityId} />
  )
}

const lastRequest = () => query.mock.lastCall![1] as QueryRequest

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

  it('narrows runs to one subtype, in the query and the activity count', async () => {
    render(<Harness />)
    await screen.findAllByTestId('chart')
    expect(screen.getByText('All 3 activities')).toBeInTheDocument()
    const select = await screen.findByLabelText('Runs subtype')
    expect(within(select).getByText('Trail runs (2)')).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'trail' } })
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
    expect((query.mock.calls[1][1] as QueryRequest).filters?.activity_subtypes).toEqual({ run: ['trail'] })
    expect(screen.getByText('All 2 activities')).toBeInTheDocument()
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

  it('deletes a stored activity after confirming, then refetches', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(<Harness />)
    await screen.findAllByTestId('chart')
    fireEvent.click(await screen.findByText('All 3 activities'))
    const dialog = await screen.findByRole('dialog')

    confirm.mockReturnValueOnce(false)
    fireEvent.click(within(dialog).getByLabelText('Delete Run 2 permanently'))
    expect(deleteActivity).not.toHaveBeenCalled()

    confirm.mockReturnValueOnce(true)
    const queriesBefore = query.mock.calls.length
    fireEvent.click(within(dialog).getByLabelText('Delete Run 2 permanently'))
    await waitFor(() => expect(deleteActivity).toHaveBeenCalledWith('/sessions/s', 'a2'))
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(queriesBefore))
    confirm.mockRestore()
  })

  describe('individual activity mode', () => {
    const openMode = async () => {
      render(<Harness />)
      await screen.findAllByTestId('chart')
      fireEvent.click(screen.getByRole('button', { name: 'Individual activity' }))
      await screen.findByRole('heading', { name: 'Run 3' })
    }

    it('opens the newest activity and queries only it', async () => {
      await openMode()
      expect(screen.getByRole('button', { name: 'Individual activity' })).toHaveAttribute('aria-pressed', 'true')
      await waitFor(() => expect(lastRequest().filters?.activity_ids).toEqual(['a3']))
      expect(lastRequest().panels.every((p) => p.group_by === 'point')).toBe(true)
      expect(screen.getByRole('toolbar', { name: 'Activity layout' })).toBeInTheDocument()
      expect(within(screen.getByLabelText('Activity summary')).getByText('Average heart rate')).toBeInTheDocument()
      expect(await screen.findAllByTestId('chart')).toHaveLength(3)
    })

    it('steps to older and newer activities', async () => {
      await openMode()
      expect(screen.getByRole('button', { name: 'Newer →' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '← Older' }))
      await screen.findByRole('heading', { name: 'Run 2' })
      await waitFor(() => expect(lastRequest().filters?.activity_ids).toEqual(['a2']))
      fireEvent.click(screen.getByRole('button', { name: '← Older' }))
      // The oldest has summary data only (a CSV row), so there's nothing to chart.
      await screen.findByText(/summary data only/)
      expect(screen.getByRole('button', { name: '← Older' })).toBeDisabled()
    })

    it('opens an activity picked in the chooser', async () => {
      await openMode()
      fireEvent.click(screen.getByRole('button', { name: 'Choose activity' }))
      const dialog = screen.getByRole('dialog', { name: 'Open an activity' })
      fireEvent.change(within(dialog).getByLabelText('Search names or dates'), { target: { value: 'run 2' } })
      expect(within(dialog).queryByRole('button', { name: 'Run 3' })).not.toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Run 2' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await screen.findByRole('heading', { name: 'Run 2' })
    })

    it('opens a point clicked in an aggregate chart', async () => {
      render(<Harness />)
      fireEvent.click((await screen.findAllByRole('button', { name: /^Open a2 from/ }))[0])
      await screen.findByRole('heading', { name: 'Run 2' })
      await waitFor(() => expect(lastRequest().filters?.activity_ids).toEqual(['a2']))
    })

    it('edits panels without grouping or series, and lists only activity layouts', async () => {
      await openMode()
      const layouts = screen.getByLabelText('Activity layout', { selector: 'select' })
      expect(within(layouts).getAllByRole('option').map((o) => o.textContent)).toEqual(['Activity overview'])
      fireEvent.click(screen.getByRole('button', { name: 'Add panel' }))
      const dialog = screen.getByRole('dialog')
      expect(within(dialog).queryByText('Each point is')).not.toBeInTheDocument()
      expect(within(dialog).queryByText('Series')).not.toBeInTheDocument()
      expect(within(within(dialog).getByLabelText('Y axis data')).queryByText('Activity summary')).not.toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(await screen.findAllByTestId('chart')).toHaveLength(4)
      fireEvent.click(screen.getByRole('button', { name: 'Aggregate activities' }))
      const dashboards = await screen.findByLabelText('Dashboard', { selector: 'select' })
      expect(within(dashboards).getAllByRole('option').map((o) => o.textContent)).toEqual(['Running'])
    })
  })
})
