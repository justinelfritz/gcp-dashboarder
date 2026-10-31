// Turn a panel's query result into a Plotly figure and a table, in the user's display units.
import type { Data, Layout } from 'plotly.js'
import type { ActivityType, AxisInfo, AxisSpec, PanelResult } from '../api/client'
import { y2Slots, yAggregates } from '../dashboard/model'
import type { DateWindow } from '../dashboard/model'
import { LINE_STYLES } from '../dashboard/types'
import type { PanelConfig, Settings } from '../dashboard/types'
import type { ChartTheme } from './palette'
import { axisTitle, clockTicks, displayUnit, formatValue } from './units'
import type { DisplayUnit } from './units'

export interface FigureContext {
  settings: Settings
  activityTypes: ActivityType[]
  theme: ChartTheme
  /** activity_id -> name, for tooltips and the table. */
  activityNames?: Map<string, string>
  /** The dashboard's chosen period, so date axes (and the Home button) show all of it. */
  dateWindow?: DateWindow
}



export interface Figure {
  data: Data[]
  layout: Partial<Layout>
}

interface Axes {
  xTime: boolean
  xUnit: DisplayUnit | null
  yUnit: DisplayUnit
  xTitle: string
  yTitle: string
  /** The y quantity's name without units, e.g. "Total distance". */
  yLabel: string
}

function axes(config: PanelConfig, result: PanelResult, ctx: FigureContext, ySpec: AxisSpec = config.y): Axes {
  const x = result.x as AxisInfo
  const y = result.y as AxisInfo
  const xTime = x.kind === 'datetime'
  const xUnit = xTime ? null : displayUnit(x.unit, x.field, ctx.settings.units, ctx.activityTypes)
  const yUnit = displayUnit(y.unit, y.field, ctx.settings.units, ctx.activityTypes)
  const xTitle = xTime ? x.label : axisTitle(x.label, xUnit!)
  const prefix = yAggregates({ group_by: config.group_by, y: ySpec }) ? AGG_PREFIX[ySpec.agg ?? 'mean'] : ''
  const yLabel = prefix ? `${prefix} ${y.label[0].toLowerCase()}${y.label.slice(1)}` : y.label
  return { xTime, xUnit, yUnit, xTitle, yTitle: axisTitle(yLabel, yUnit), yLabel }
}

// Axis-title wording for each aggregation; the mean is the default and goes unstated.
const AGG_PREFIX: Record<string, string> = {
  mean: '',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  sum: 'Total',
  count: 'Count of',
  std: 'Std dev of',
}

function xHoverFormat(config: PanelConfig): string {
  if (config.group_by === 'week') return 'Week of %b %-d, %Y'
  if (config.group_by === 'month') return '%B %Y'
  return '%a %b %-d, %Y %-I:%M %p'
}

export function hasData(result: PanelResult): boolean {
  return result.series.some((s) => s.points.length > 0)
}

/** True when the panel has a second quantity and its result is ready to draw. */
function ready2(config: PanelConfig, result2: PanelResult | undefined): result2 is PanelResult {
  return !!config.y2 && !!result2 && !result2.error && !!result2.x && !!result2.y
}

export interface LinearFit {
  slope: number
  intercept: number
  r2: number
}

/** Least-squares line through the points; null with fewer than two distinct x values. */
export function leastSquares(xs: number[], ys: number[]): LinearFit | null {
  const n = xs.length
  if (n < 2) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2
    sxy += (xs[i] - mx) * (ys[i] - my)
    syy += (ys[i] - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : (sxy * sxy) / (sxx * syy) }
}

interface SeriesFit {
  label: string
  fit: LinearFit
  /** The fitted x range: epoch ms of wall-clock time on date axes, display units otherwise. */
  x0: number
  x1: number
}

/** A trend per series, fitted to the values as plotted (display units; dates as wall-clock ms). */
function seriesFits(result: PanelResult, a: Axes): (SeriesFit | null)[] {
  return result.series.map((s) => {
    const xs = s.points.map((p) => (a.xTime ? wallClockMs(p.x as string) : (p.x as number) * a.xUnit!.factor))
    const ys = s.points.map((p) => p.y * a.yUnit.factor)
    const fit = leastSquares(xs, ys)
    return fit && { label: s.label, fit, x0: Math.min(...xs), x1: Math.max(...xs) }
  })
}

interface TraceOptions {
  /** Plotly axis id the traces are drawn against. */
  axis: 'y' | 'y2'
  /** Add each series' least-squares trendline. */
  trend: boolean
  slots: number[]
  /** Right-axis traces: open markers in the panel's right-axis line style, never bars. */
  secondary: boolean
  /** Name each trace with its quantity, since two quantities share the panel. */
  named: boolean
}

function buildTraces(
  config: PanelConfig, result: PanelResult, a: Axes, ctx: FigureContext, opts: TraceOptions,
  yValues: number[], xValues: number[],
): Data[] {
  const { theme } = ctx
  const isBar = config.chart === 'bar' && !opts.secondary
  const isScatter = config.chart === 'scatter'
  const multi = result.series.length > 1
  const fits = opts.trend ? seriesFits(result, a) : []
  return result.series.flatMap((s, i) => {
    const color = theme.series[opts.slots[i] % theme.series.length]
    const xs = s.points.map((p) => (a.xTime ? p.x : (p.x as number) * a.xUnit!.factor))
    const ys = s.points.map((p) => p.y * a.yUnit.factor)
    const errs = s.points.map((p) => (p.error == null ? 0 : p.error * a.yUnit.factor))
    const hasErrors = config.error !== 'none' && s.points.some((p) => p.error != null)
    ys.forEach((y, j) => yValues.push(y - errs[j], y + errs[j]))
    if (!a.xTime) xs.forEach((x) => xValues.push(x as number))
    const custom = s.points.map((p, j) => [
      `${formatValue(ys[j], a.yUnit)} ${a.yUnit.label}`.trim(),
      hasErrors && p.error != null ? ` ± ${formatValue(errs[j], a.yUnit)}` : '',
      p.n,
      (p.activity_id && ctx.activityNames?.get(p.activity_id)) || '',
      a.xTime ? '' : `${formatValue(xs[j] as number, a.xUnit!)} ${a.xUnit!.label}`.trim(),
    ])
    const name = opts.named ? (multi ? `${s.label} · ${a.yLabel}` : a.yLabel) : s.label
    // With two quantities, the hover names each value's quantity rather than relying on color.
    const lead = opts.named ? '%{fullData.name}: ' : ''
    const hover = isScatter
      ? `${lead}<b>%{customdata[0]}</b>%{customdata[1]}<br>%{customdata[4]}<br>%{customdata[3]}<extra>${opts.named ? '' : '%{fullData.name}'}</extra>`
      : `${lead}<b>%{customdata[0]}</b>%{customdata[1]}  ·  n = %{customdata[2]}<br>%{customdata[3]}<extra></extra>`
    const marker = isBar
      ? { color }
      : opts.secondary
        // Open markers: a second cue, besides hue, that this is the right-axis quantity.
        ? { color: theme.surface, size: isScatter ? 9 : 8, line: { color, width: 2 } }
        : { color, size: isScatter ? 9 : 8, line: { color: theme.surface, width: 2 } }
    const trace = {
      type: isBar ? 'bar' : 'scatter',
      name,
      legendgroup: `${opts.axis}-${i}`,
      x: xs,
      y: ys,
      yaxis: opts.axis,
      customdata: custom,
      hovertemplate: hover,
      marker,
      ...(isBar
        ? {}
        : {
          mode: isScatter ? 'markers' : 'lines+markers',
          line: { color, width: 2, ...(opts.secondary ? { dash: config.y2_line ?? 'dash' } : {}) },
        }),
      ...(hasErrors
        ? { error_y: { type: 'data', array: errs, visible: true, color, thickness: 1.5, width: 4 } }
        : {}),
    } as Data
    const f = fits[i]
    if (!f) return [trace]
    // A thin, translucent line in the series' color; hiding the series in the legend hides it too.
    const ends = [f.x0, f.x1]
    const trend = {
      type: 'scatter',
      mode: 'lines',
      name: `${name} trend`,
      legendgroup: `${opts.axis}-${i}`,
      showlegend: false,
      x: a.xTime ? ends.map(wallClockIso) : ends,
      y: ends.map((x) => f.fit.intercept + f.fit.slope * x),
      yaxis: opts.axis,
      line: { color, width: 1.5 },
      opacity: 0.6,
      hoverinfo: 'skip',
    } as Data
    return [trace, trend]
  })
}

/**
 * One line per trendline, saying how fast the quantity changes: per week (per month for monthly
 * points) on date axes, per x unit otherwise. Readable without hovering, and kept beside the chart.
 */
export function trendNotes(config: PanelConfig, result: PanelResult, ctx: FigureContext, result2?: PanelResult): string[] {
  const two = ready2(config, result2)
  const quantities: [PanelResult, Axes, boolean][] = []
  if (result.x && result.y && !result.error) quantities.push([result, axes(config, result, ctx), !!config.trend])
  if (two) quantities.push([result2, axes(config, result2, ctx, config.y2!), !!config.y2_trend])
  const notes: string[] = []
  for (const [r, a, on] of quantities) {
    if (!on) continue
    const per = a.xTime ? (config.group_by === 'month' ? 30.44 * DAY_MS : 7 * DAY_MS) : 1
    const perLabel = a.xTime ? (config.group_by === 'month' ? 'month' : 'week') : a.xUnit!.label || 'unit'
    const multi = r.series.length > 1
    for (const f of seriesFits(r, a)) {
      if (!f) continue
      const who = [multi ? f.label : '', two ? a.yLabel : ''].filter(Boolean).join(' · ')
      const rate = f.fit.slope * per
      const value = `${rate < 0 ? '−' : '+'}${formatValue(Math.abs(rate), a.yUnit)} ${a.yUnit.label}`.replace(/\s+$/, '')
      notes.push(`${who ? `${who} trend` : 'Trend'}: ${value} per ${perLabel} (r² ${f.fit.r2.toFixed(2)})`)
    }
  }
  return notes
}

function rightHint(config: PanelConfig): string {
  return LINE_STYLES.find((l) => l.value === (config.y2_line ?? 'dash'))!.hint
}

function yAxisFor(base: Partial<Layout['yaxis']>, title: string, unit: DisplayUnit, values: number[], bars: boolean): Partial<Layout['yaxis']> {
  const axis: Partial<Layout['yaxis']> = { ...base, title: { ...(base.title as object), text: title } }
  if (unit.format === 'clock' && values.length) {
    Object.assign(axis, clockAxis(values, unit.reversed))
  } else if (bars) {
    axis.rangemode = 'tozero'
  }
  return axis
}

/**
 * The panel's figure. `result2` is the right-axis quantity (`config.y2`), queried as a companion
 * panel with the same x axis, grouping, and series.
 */
export function buildFigure(config: PanelConfig, result: PanelResult, ctx: FigureContext, result2?: PanelResult): Figure {
  const { theme } = ctx
  const a = axes(config, result, ctx)
  const isBar = config.chart === 'bar'
  const isScatter = config.chart === 'scatter'
  const two = ready2(config, result2)
  const yValues: number[] = []
  const xValues: number[] = []
  const y2Values: number[] = []

  const data = buildTraces(config, result, a, ctx, {
    axis: 'y', trend: !!config.trend, slots: config.series.map((s, i) => s.color_slot ?? i), secondary: false, named: two,
  }, yValues, xValues)
  const a2 = two ? axes(config, result2, ctx, config.y2!) : null
  if (two) {
    data.push(...buildTraces(config, result2, a2!, ctx,
      { axis: 'y2', trend: !!config.y2_trend, slots: y2Slots(config), secondary: true, named: true }, y2Values, xValues))
  }
  if (isBar && a.xTime) fixLoneBarWidth(config, data)

  const axisBase = {
    gridcolor: theme.grid,
    linecolor: theme.baseline,
    zeroline: false,
    automargin: true,
    tickfont: { color: theme.muted, size: 11 },
    title: { font: { color: theme.textSecondary, size: 12 } },
  }
  // Axis titles stay in text ink; a mark-style hint says which lines belong to which axis.
  const leftMark = isBar ? '▮ ' : isScatter ? '● ' : '— '
  const yaxis = yAxisFor(axisBase, two ? leftMark + a.yTitle : a.yTitle, a.yUnit, yValues, isBar)
  const xaxis: Partial<Layout['xaxis']> = {
    ...axisBase,
    showline: true,
    showgrid: !a.xTime,
    title: { ...axisBase.title, text: a.xTitle },
  }
  if (a.xTime) {
    const all = two ? { ...result, series: [...result.series, ...result2.series] } : result
    Object.assign(xaxis, { type: 'date', hoverformat: xHoverFormat(config) }, dateAxis(config, all, ctx.dateWindow))
  } else if (a.xUnit?.format === 'clock' && xValues.length) {
    Object.assign(xaxis, clockAxis(xValues, false))
  }

  const legend = two || result.series.length >= 2
  const layout: Partial<Layout> = {
    paper_bgcolor: theme.surface,
    plot_bgcolor: theme.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, color: theme.textSecondary },
    margin: { l: 8, r: two ? 8 : 12, t: legend ? 32 : 8, b: 8 },
    showlegend: legend,
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { color: theme.textSecondary } },
    hovermode: isScatter ? 'closest' : 'x unified',
    hoverlabel: { bgcolor: theme.surface, bordercolor: theme.grid, font: { color: theme.textPrimary } },
    xaxis,
    yaxis,
    ...(two
      ? {
        // One grid only: the right axis's gridlines would cross the left's at unrelated values.
        yaxis2: {
          ...yAxisFor(axisBase, `${a2!.yTitle} ${isScatter ? '○' : rightHint(config)}`, a2!.yUnit, y2Values, false),
          overlaying: 'y',
          side: 'right',
          showgrid: false,
        },
      }
      : {}),
    bargap: 0.35,
    bargroupgap: 0.1,
    ...(isBar ? { barcornerradius: 4 } : {}),
  }
  return { data, layout }
}

const DAY_MS = 86_400_000

/**
 * Plotly sizes bars from the gap between neighbouring x values; with a single week or month
 * there is none, and the bar shrinks to a hairline on a period-wide axis. Size it to the bucket.
 */
function fixLoneBarWidth(config: PanelConfig, data: Data[]): void {
  const bucket = config.group_by === 'week' ? 7 * DAY_MS : config.group_by === 'month' ? 30.44 * DAY_MS : 0
  const bars = data.filter((t) => (t as { type?: string }).type === 'bar') as { x: unknown[]; width?: number }[]
  const positions = new Set(bars.flatMap((t) => t.x.map(String)))
  if (!bucket || positions.size !== 1) return
  // Same share of the bucket as the bar gap leaves elsewhere, split between grouped series.
  for (const t of bars) t.width = (bucket * 0.65) / bars.length
}

// The API sends local wall-clock times without an offset, and Plotly plots date strings as wall
// clock too. Do date math in UTC so the browser's own timezone never shifts anything.
function wallClockMs(iso: string): number {
  const [d, t = '00:00:00'] = iso.split('T')
  const [y, m, day] = d.split('-').map(Number)
  const [hh, mm, ss] = t.split(':').map(Number)
  return Date.UTC(y, m - 1, day, hh || 0, mm || 0, Math.floor(ss || 0))
}

function wallClockIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Date-axis range and ticks. The range covers the dashboard's chosen period (so a sparse "last 90
 * days" still shows 90 days, and Plotly's Home button returns to it), widened if a week or month
 * bucket starts before it. "All time" fits the data. Ticks sit on week/month buckets.
 */
function dateAxis(config: PanelConfig, result: PanelResult, window: DateWindow = {}): Partial<Layout['xaxis']> {
  const times = result.series.flatMap((s) => s.points.map((p) => wallClockMs(p.x as string)))
  if (!times.length) return {}
  const first = Math.min(...times)
  const last = Math.max(...times)
  const min = Math.min(window.start ?? first, first)
  const max = Math.max(window.end ?? last, last)
  if (config.group_by === 'week') {
    const weeks = Math.round((max - min) / (7 * DAY_MS)) + 1
    return {
      tick0: wallClockIso(first),
      dtick: 7 * DAY_MS * Math.max(1, Math.ceil(weeks / 8)),
      tickformat: '%b %-d',
      range: [wallClockIso(min - 4 * DAY_MS), wallClockIso(max + 4 * DAY_MS)],
    }
  }
  if (config.group_by === 'month') {
    const months = Math.round((max - min) / (30.44 * DAY_MS)) + 1
    return {
      tick0: wallClockIso(first),
      dtick: `M${Math.max(1, Math.ceil(months / 8))}`,
      tickformat: '%b %Y',
      range: [wallClockIso(min - 16 * DAY_MS), wallClockIso(max + 16 * DAY_MS)],
    }
  }
  // Pad the data's ends, but not an end the chosen period sets. Without padding, a single
  // activity (or a few on one day) would zoom the axis to milliseconds.
  const pad = Math.max((max - min) * 0.04, max - min < 2 * DAY_MS ? 3 * DAY_MS : 0)
  const lo = window.start === undefined ? min - pad : min
  const hi = window.end === undefined ? max + pad : max
  return { range: [wallClockIso(lo), wallClockIso(hi)] }
}

function clockAxis(values: number[], reversed: boolean): Partial<Layout['yaxis']> {
  let min = Math.min(...values)
  let max = Math.max(...values)
  const pad = Math.max((max - min) * 0.08, 5)
  min -= pad
  max += pad
  const ticks = clockTicks(min, max)
  return {
    tickmode: 'array',
    tickvals: ticks.vals,
    ticktext: ticks.text,
    range: reversed ? [max, min] : [min, max],
    autorange: false,
  }
}

export interface TableData {
  columns: string[]
  rows: string[][]
}

/** The same values as the chart, as text: every plotted point is readable without hovering. */
export function buildTable(config: PanelConfig, result: PanelResult, ctx: FigureContext, result2?: PanelResult): TableData {
  const a = axes(config, result, ctx)
  const multi = result.series.length > 1
  const showError = config.error !== 'none'
  const perActivity = config.group_by === 'activity'
  const xText = (x: string | number) =>
    a.xTime ? formatDate(x as string, config) : formatValue((x as number) * a.xUnit!.factor, a.xUnit!)
  const yText = (y: number, u: DisplayUnit) => formatValue(y * u.factor, u)
  const errText = (e: number | null, u: DisplayUnit) => (e == null ? '' : formatValue(e * u.factor, u))
  const name = (id: string | null | undefined) => (id && ctx.activityNames?.get(id)) || ''

  if (!ready2(config, result2)) {
    const columns = [
      ...(multi ? ['Series'] : []), a.xTitle, a.yTitle, ...(showError ? ['±'] : []), 'n', ...(perActivity ? ['Activity'] : []),
    ]
    const rows = result.series.flatMap((s) => s.points.map((p) => [
      ...(multi ? [s.label] : []),
      xText(p.x),
      yText(p.y, a.yUnit),
      ...(showError ? [errText(p.error, a.yUnit)] : []),
      String(p.n),
      ...(perActivity ? [name(p.activity_id)] : []),
    ]))
    return { columns, rows }
  }

  const a2 = axes(config, result2, ctx, config.y2!)
  if (config.group_by === 'point') {
    // Laps or samples of two quantities don't pair up row for row; list each quantity's points.
    const columns = [...(multi ? ['Series'] : []), 'Quantity', a.xTitle, 'Value', ...(showError ? ['±'] : []), 'n']
    const rows = ([[result, a], [result2, a2]] as const).flatMap(([r, ax]) => r.series.flatMap((s) => s.points.map((p) => [
      ...(multi ? [s.label] : []),
      ax.yLabel,
      xText(p.x),
      `${yText(p.y, ax.yUnit)} ${ax.yUnit.label}`.trim(),
      ...(showError ? [errText(p.error, ax.yUnit)] : []),
      String(p.n),
    ])))
    return { columns, rows }
  }

  // Both quantities share x and series, so join their points on series, x, and activity.
  const columns = [
    ...(multi ? ['Series'] : []), a.xTitle,
    a.yTitle, ...(showError ? ['±'] : []),
    a2.yTitle, ...(showError ? ['± '] : []),
    'n', ...(perActivity ? ['Activity'] : []),
  ]
  const key = (p: PanelResult['series'][number]['points'][number]) => `${p.x}|${p.activity_id ?? ''}`
  const rows: string[][] = []
  result.series.forEach((s, i) => {
    const right = new Map((result2.series[i]?.points ?? []).map((p) => [key(p), p]))
    const left = s.points.map((p) => ({ p, q: right.get(key(p)) }))
    const unmatched = [...right.values()].filter((q) => !s.points.some((p) => key(p) === key(q)))
    const pairs = [...left, ...unmatched.map((q) => ({ p: undefined, q }))]
    for (const { p, q } of pairs) {
      const any = (p ?? q)!
      rows.push([
        ...(multi ? [s.label] : []),
        xText(any.x),
        p ? yText(p.y, a.yUnit) : '',
        ...(showError ? [p ? errText(p.error, a.yUnit) : ''] : []),
        q ? yText(q.y, a2.yUnit) : '',
        ...(showError ? [q ? errText(q.error, a2.yUnit) : ''] : []),
        String(any.n),
        ...(perActivity ? [name(any.activity_id)] : []),
      ])
    }
  })
  return { columns, rows }
}

function formatDate(iso: string, config: PanelConfig): string {
  // Dates are local wall-clock times without an offset; parse the parts so no timezone shifts them.
  const [datePart, timePart = '00:00'] = iso.split('T')
  const [y, m, d] = datePart.split('-').map(Number)
  const [hh, mm] = timePart.split(':').map(Number)
  const date = new Date(y, m - 1, d, hh, mm)
  if (config.group_by === 'month') return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
  if (config.group_by === 'week') return `Week of ${date.toLocaleDateString()}`
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}
