import { describe, expect, it } from 'vitest'
import type { PanelResult } from '../api/client'
import { blankPanel } from '../dashboard/model'
import { DEFAULT_SETTINGS } from '../dashboard/types'
import type { PanelConfig } from '../dashboard/types'
import { buildFigure, buildTable } from './buildFigure'
import { DARK, LIGHT } from './palette'

// The trace fields these tests read; Plotly's Data union doesn't narrow on its own.
interface Trace {
  type?: string
  y: number[]
  error_y: { array: number[] }
  marker: { color: string }
}
const traces = (data: unknown) => data as Trace[]

const ctx = { settings: DEFAULT_SETTINGS, activityTypes: ['run' as const], theme: LIGHT }

const pacePanel: PanelConfig = {
  ...blankPanel(0),
  y: { field: 'avg_pace_s_per_km', level: 'lap', agg: 'mean' },
  error: 'std',
  series: [
    { label: '5k', color_slot: 0, distance_m: 5000 },
    { label: '10k', color_slot: 1, distance_m: 10000 },
  ],
}

const paceResult: PanelResult = {
  id: pacePanel.id,
  x: { field: 'start_time', label: 'Date', unit: 'datetime', kind: 'datetime' },
  y: { field: 'avg_pace_s_per_km', label: 'Lap pace', unit: 's/km', kind: 'number' },
  series: [
    { label: '5k', color: null, n_activities: 2, points: [
      { x: '2026-09-05T08:00:00', y: 420, error: 6, n: 3, activity_id: 'a1' },
      { x: '2026-09-12T08:00:00', y: 410, error: 4, n: 3, activity_id: 'a2' },
    ] },
    { label: '10k', color: null, n_activities: 1, points: [
      { x: '2026-09-19T08:00:00', y: 450, error: 10, n: 6, activity_id: 'a3' },
    ] },
  ],
  warnings: [],
  error: null,
}

describe('buildFigure', () => {
  it('converts pace to min/mi, scales error bars, and colors by slot', () => {
    const { data, layout } = buildFigure(pacePanel, paceResult, ctx)
    const [s1, s2] = traces(data)
    expect(s1.y[0]).toBeCloseTo(420 * 1.609344)
    expect(s1.error_y.array[0]).toBeCloseTo(6 * 1.609344)
    expect(s1.marker.color).toBe(LIGHT.series[0])
    expect(s2.marker.color).toBe(LIGHT.series[1])
    expect(layout.showlegend).toBe(true)
    expect(layout.yaxis?.title).toMatchObject({ text: 'Lap pace (min/mi)' })
    // Pace axis is reversed (faster is up) and ticks are clock-formatted.
    const range = layout.yaxis?.range as number[]
    expect(range[0]).toBeGreaterThan(range[1])
    expect((layout.yaxis?.ticktext as string[]).every((t) => /^\d+:\d\d$/.test(t))).toBe(true)
    expect(layout.xaxis?.type).toBe('date')
  })

  it('keeps colors on their series when a series is removed, and drops the legend for one', () => {
    const one = { ...pacePanel, series: [pacePanel.series[1]] }
    const result = { ...paceResult, series: [paceResult.series[1]] }
    const { data, layout } = buildFigure(one, result, { ...ctx, theme: DARK })
    expect(traces(data)[0].marker.color).toBe(DARK.series[1])
    expect(layout.showlegend).toBe(false)
  })

  it('draws bars from zero for weekly totals', () => {
    const weekly: PanelConfig = { ...blankPanel(0), chart: 'bar', group_by: 'week', y: { field: 'distance_m', level: 'activity', agg: 'sum' } }
    const result: PanelResult = {
      id: weekly.id,
      x: { field: 'week', label: 'Week', unit: 'date', kind: 'datetime' },
      y: { field: 'distance_m', label: 'Distance', unit: 'm', kind: 'number' },
      series: [{ label: 'All', color: null, n_activities: 2, points: [{ x: '2026-08-31', y: 16093.44, error: null, n: 2, activity_id: null }] }],
      warnings: [],
      error: null,
    }
    const { data, layout } = buildFigure(weekly, result, ctx)
    expect(traces(data)[0].type).toBe('bar')
    expect(traces(data)[0].y[0]).toBeCloseTo(10)
    expect(layout.yaxis?.rangemode).toBe('tozero')
    expect(layout.yaxis?.title).toMatchObject({ text: 'Total distance (mi)' })
  })
})

describe('date axes', () => {
  it('gives a lone activity a multi-day range instead of milliseconds', () => {
    const one = { ...paceResult, series: [paceResult.series[1]] }
    const { layout } = buildFigure({ ...pacePanel, series: [pacePanel.series[1]] }, one, ctx)
    expect(layout.xaxis?.range).toEqual(['2026-09-16 08:00:00', '2026-09-22 08:00:00'])
  })

  it('puts weekly ticks on the Monday buckets', () => {
    const weekly: PanelConfig = { ...blankPanel(0), chart: 'bar', group_by: 'week' }
    const result: PanelResult = {
      ...paceResult,
      x: { field: 'week', label: 'Week', unit: 'date', kind: 'datetime' },
      series: [{ label: 'All', color: null, n_activities: 2, points: [
        { x: '2026-08-31', y: 1, error: null, n: 1, activity_id: null },
        { x: '2026-10-19', y: 1, error: null, n: 1, activity_id: null },
      ] }],
    }
    const { layout } = buildFigure(weekly, result, ctx)
    expect(layout.xaxis).toMatchObject({ tick0: '2026-08-31 00:00:00', dtick: 7 * 86_400_000, tickformat: '%b %-d' })
  })
})

describe('buildTable', () => {
  it('lists every point in display units with names', () => {
    const names = new Map([['a1', 'Morning Run']])
    const table = buildTable(pacePanel, paceResult, { ...ctx, activityNames: names })
    expect(table.columns).toEqual(['Series', 'Date', 'Lap pace (min/mi)', '±', 'n', 'Activity'])
    expect(table.rows).toHaveLength(3)
    expect(table.rows[0].slice(2)).toEqual(['11:16', '0:10', '3', 'Morning Run'])
  })
})
