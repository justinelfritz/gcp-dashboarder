import { describe, expect, it } from 'vitest'
import type { PanelResult } from '../api/client'
import { blankPanel } from '../dashboard/model'
import { DEFAULT_SETTINGS } from '../dashboard/types'
import type { PanelConfig } from '../dashboard/types'
import { ACTIVITY_ID_INDEX, buildFigure, buildTable, DENSE_POINTS, leastSquares, trendNotes } from './buildFigure'
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
  it('carries each point\'s activity, and says a click opens it when it can', () => {
    const custom = (data: unknown) => (data as { customdata: unknown[][]; hovertemplate: string }[])[0]
    const plain = custom(buildFigure(pacePanel, paceResult, ctx).data)
    expect(plain.customdata.map((c) => c[ACTIVITY_ID_INDEX])).toEqual(['a1', 'a2'])
    expect(plain.customdata[0].join('')).not.toContain('Click')
    const openable = custom(buildFigure(pacePanel, paceResult, { ...ctx, openable: true }).data)
    expect(openable.customdata[0].join('')).toContain('Click to open this activity')
  })

  it('ticks lap numbers on whole numbers', () => {
    const panel: PanelConfig = { ...pacePanel, group_by: 'point', error: 'none', x: { field: 'lap_index', level: 'lap' }, series: [{ label: 'This activity', color_slot: 0 }] }
    const laps = (n: number): PanelResult => ({
      ...paceResult,
      x: { field: 'lap_index', label: 'Lap number', unit: '', kind: 'number' },
      series: [{ label: 'This activity', color: null, n_activities: 1, points: Array.from({ length: n }, (_, i) => ({
        x: i + 1, y: 400, error: null, n: 1, activity_id: 'a1',
      })) }],
    })
    expect(buildFigure(panel, laps(4), ctx).layout.xaxis).toMatchObject({ tick0: 1, dtick: 1 })
    expect(buildFigure(panel, laps(27), ctx).layout.xaxis).toMatchObject({ dtick: 4 })
  })

  it('draws a long per-sample line without markers, and no counts in its tooltip', () => {
    const panel: PanelConfig = { ...pacePanel, group_by: 'point', error: 'none', series: [{ label: 'This activity', color_slot: 0 }] }
    const result = (n: number): PanelResult => ({
      ...paceResult,
      x: { field: 'elapsed_s', label: 'Time into activity', unit: 's', kind: 'number' },
      y: { field: 'hr', label: 'Heart rate', unit: 'bpm', kind: 'number' },
      series: [{ label: 'This activity', color: null, n_activities: 1, points: Array.from({ length: n }, (_, i) => ({
        x: i, y: 140 + (i % 7), error: null, n: 1, activity_id: 'a1',
      })) }],
    })
    const trace = (n: number) => (buildFigure(panel, result(n), ctx).data as { mode: string; hovertemplate: string }[])[0]
    expect(trace(DENSE_POINTS + 1).mode).toBe('lines')
    expect(trace(DENSE_POINTS).mode).toBe('lines+markers')
    expect(trace(10).hovertemplate).not.toContain('n =')
    expect((buildFigure(pacePanel, paceResult, ctx).data as { hovertemplate: string }[])[0].hovertemplate).toContain('n =')
  })

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

  it('gives a lone weekly bar a week-sized width', () => {
    const weekly: PanelConfig = { ...blankPanel(0), chart: 'bar', group_by: 'week' }
    const one: PanelResult = {
      ...paceResult,
      x: { field: 'week', label: 'Week', unit: 'date', kind: 'datetime' },
      series: [{ label: 'All', color: null, n_activities: 1, points: [{ x: '2026-10-19', y: 1, error: null, n: 1, activity_id: null }] }],
    }
    const width = (r: PanelResult) => (buildFigure(weekly, r, ctx).data[0] as { width?: number }).width
    expect(width(one)).toBeCloseTo(7 * 86_400_000 * 0.65)
    const two = { ...one, series: [{ ...one.series[0], points: [...one.series[0].points, { ...one.series[0].points[0], x: '2026-10-26' }] }] }
    expect(width(two)).toBeUndefined() // Plotly sizes it from the spacing
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

describe('right-axis quantity', () => {
  const hrPanel: PanelConfig = { ...pacePanel, y2: { field: 'avg_hr', level: 'activity', agg: 'mean' } }
  const hrResult: PanelResult = {
    ...paceResult,
    id: `${pacePanel.id}~y2`,
    y: { field: 'avg_hr', label: 'Average heart rate', unit: 'bpm', kind: 'number' },
    series: [
      { label: '5k', color: null, n_activities: 2, points: [
        { x: '2026-09-05T08:00:00', y: 150, error: null, n: 1, activity_id: 'a1' },
        { x: '2026-09-12T08:00:00', y: 155, error: null, n: 1, activity_id: 'a2' },
      ] },
      { label: '10k', color: null, n_activities: 1, points: [
        { x: '2026-09-19T08:00:00', y: 160, error: null, n: 1, activity_id: 'a3' },
      ] },
    ],
  }
  interface Y2Trace extends Trace { yaxis: string; name: string; line: { dash?: string }; marker: { color: string; line: { color: string } } }

  it('draws the second quantity dashed on its own right axis, with its own unit and hues', () => {
    const { data, layout } = buildFigure(hrPanel, paceResult, ctx, hrResult)
    const all = data as unknown as Y2Trace[]
    expect(all.map((t) => t.yaxis)).toEqual(['y', 'y', 'y2', 'y2'])
    const [, , hr5k, hr10k] = all
    expect(hr5k.line.dash).toBe('dash')
    expect(hr5k.y[0]).toBe(150) // bpm needs no conversion
    // Slots 0 and 1 belong to the left series, so the right axis takes the next free ones.
    expect(hr5k.marker.line.color).toBe(LIGHT.series[2])
    expect(hr10k.marker.line.color).toBe(LIGHT.series[3])
    expect(hr5k.name).toBe('5k · Average heart rate')
    expect(layout.yaxis2).toMatchObject({ overlaying: 'y', side: 'right', showgrid: false })
    expect(layout.yaxis2?.title).toMatchObject({ text: 'Average heart rate (bpm) - -' })
    expect(layout.yaxis2?.autorange).not.toBe(false) // not a reversed clock axis like pace
    const range = layout.yaxis?.range as number[]
    expect(range[0]).toBeGreaterThan(range[1]) // the left pace axis stays reversed
  })

  it('uses the chosen right-axis colors and line style', () => {
    const styled: PanelConfig = {
      ...hrPanel,
      y2_line: 'dot',
      series: [{ ...hrPanel.series[0], y2_color_slot: 6 }, hrPanel.series[1]],
    }
    const { data, layout } = buildFigure(styled, paceResult, ctx, hrResult)
    const [, , hr5k, hr10k] = data as unknown as Y2Trace[]
    expect(hr5k.line.dash).toBe('dot')
    expect(hr5k.marker.line.color).toBe(LIGHT.series[6])
    expect(hr10k.marker.line.color).toBe(LIGHT.series[3]) // no pick: second free slot
    expect(layout.yaxis2?.title).toMatchObject({ text: 'Average heart rate (bpm) ···' })
  })

  it('names the quantity in the legend even with one series', () => {
    const one = { ...hrPanel, series: [pacePanel.series[0]] }
    const { data, layout } = buildFigure(one, { ...paceResult, series: [paceResult.series[0]] }, ctx, { ...hrResult, series: [hrResult.series[0]] })
    expect(layout.showlegend).toBe(true)
    expect((data as unknown as Y2Trace[]).map((t) => t.name)).toEqual(['Lap pace', 'Average heart rate'])
  })

  it('draws the second quantity as a line on bar charts', () => {
    const { data } = buildFigure({ ...hrPanel, chart: 'bar' }, paceResult, ctx, hrResult)
    expect(traces(data).map((t) => t.type)).toEqual(['bar', 'bar', 'scatter', 'scatter'])
  })

  it('ignores a failed right-axis result', () => {
    const { data, layout } = buildFigure(hrPanel, paceResult, ctx, { ...hrResult, error: 'bad field' })
    expect(data).toHaveLength(2)
    expect(layout.yaxis2).toBeUndefined()
  })

  it('joins both quantities into one table row per point', () => {
    const table = buildTable(hrPanel, paceResult, ctx, hrResult)
    expect(table.columns).toEqual(['Series', 'Date', 'Lap pace (min/mi)', '±', 'Average heart rate (bpm)', '± ', 'n', 'Activity'])
    expect(table.rows).toHaveLength(3)
    expect(table.rows[0].slice(2, 6)).toEqual(['11:16', '0:10', '150', ''])
  })
})

describe('trendlines', () => {
  interface TrendTrace { name: string; mode?: string; x: (string | number)[]; y: number[]; yaxis: string; showlegend?: boolean; line: { color: string } }

  it('fits a least-squares line', () => {
    const fit = leastSquares([0, 1, 2, 3], [1, 3, 5, 7])!
    expect(fit.slope).toBeCloseTo(2)
    expect(fit.intercept).toBeCloseTo(1)
    expect(fit.r2).toBeCloseTo(1)
    expect(leastSquares([1], [1])).toBeNull()
    expect(leastSquares([2, 2], [1, 5])).toBeNull() // no x spread
  })

  it('adds a thin trend per series in its color, over the series\' x range', () => {
    const { data } = buildFigure({ ...pacePanel, trend: true }, paceResult, ctx)
    const all = data as unknown as TrendTrace[]
    // 5k has two points and gets a trend; 10k has one point and doesn't.
    expect(all.map((t) => t.name)).toEqual(['5k', '5k trend', '10k'])
    const trend = all[1]
    expect(trend.mode).toBe('lines')
    expect(trend.showlegend).toBe(false)
    expect(trend.line.color).toBe(LIGHT.series[0])
    expect(trend.x).toEqual(['2026-09-05 08:00:00', '2026-09-12 08:00:00'])
    expect(trend.y[0]).toBeCloseTo(420 * 1.609344)
    expect(trend.y[1]).toBeCloseTo(410 * 1.609344)
  })

  it('reports the rate per week, in display units', () => {
    const notes = trendNotes({ ...pacePanel, trend: true }, paceResult, ctx)
    // 10 s/km faster in one week is 16 s/mi.
    expect(notes).toEqual(['5k trend: −0:16 min/mi per week (r² 1.00)'])
    expect(trendNotes(pacePanel, paceResult, ctx)).toEqual([])
  })

  it('fits the right-axis quantity on its own axis', () => {
    const hrPanel: PanelConfig = { ...pacePanel, y2: { field: 'avg_hr', level: 'activity', agg: 'mean' }, y2_trend: true }
    const hrResult: PanelResult = {
      ...paceResult,
      y: { field: 'avg_hr', label: 'Average heart rate', unit: 'bpm', kind: 'number' },
      series: [{ ...paceResult.series[0], points: paceResult.series[0].points.map((p, i) => ({ ...p, y: 150 + 7 * i, error: null })) }, paceResult.series[1]],
    }
    const all = buildFigure(hrPanel, paceResult, ctx, hrResult).data as unknown as TrendTrace[]
    const trends = all.filter((t) => t.name.endsWith('trend'))
    expect(trends.map((t) => [t.name, t.yaxis])).toEqual([['5k · Average heart rate trend', 'y2']])
    expect(trendNotes(hrPanel, paceResult, ctx, hrResult)).toEqual(['5k · Average heart rate trend: +7 bpm per week (r² 1.00)'])
  })
})

describe('date axes follow the chosen period', () => {
  const day = (d: string) => Date.parse(`${d}T00:00:00Z`)

  it('spans the whole period even when activities are sparse', () => {
    const window = { start: day('2026-08-01'), end: day('2026-10-30') }
    const { layout } = buildFigure(pacePanel, paceResult, { ...ctx, dateWindow: window })
    expect(layout.xaxis?.range).toEqual(['2026-08-01 00:00:00', '2026-10-30 00:00:00'])
  })

  it('pads only the open end of a half-open custom range', () => {
    const { layout } = buildFigure(pacePanel, paceResult, { ...ctx, dateWindow: { start: day('2026-09-01') } })
    const [lo, hi] = layout.xaxis?.range as string[]
    expect(lo).toBe('2026-09-01 00:00:00')
    expect(hi > '2026-09-19 08:00:00').toBe(true)
  })

  it('widens to a week bucket that starts before the period', () => {
    const weekly: PanelConfig = { ...blankPanel(0), chart: 'bar', group_by: 'week' }
    const result: PanelResult = {
      ...paceResult,
      x: { field: 'week', label: 'Week', unit: 'date', kind: 'datetime' },
      series: [{ label: 'All', color: null, n_activities: 1, points: [{ x: '2026-08-31', y: 1, error: null, n: 1, activity_id: null }] }],
    }
    const { layout } = buildFigure(weekly, result, { ...ctx, dateWindow: { start: day('2026-09-02'), end: day('2026-10-01') } })
    // Monday Aug 31 is before the Sep 2 start, so the axis starts at that bucket (minus padding).
    expect(layout.xaxis?.range).toEqual(['2026-08-27 00:00:00', '2026-10-05 00:00:00'])
  })
})
