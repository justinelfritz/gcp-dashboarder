// Turn a panel's query result into a Plotly figure and a table, in the user's display units.
import type { Data, Layout } from 'plotly.js'
import type { ActivityType, AxisInfo, PanelResult } from '../api/client'
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
}

function axes(config: PanelConfig, result: PanelResult, ctx: FigureContext): Axes {
  const x = result.x as AxisInfo
  const y = result.y as AxisInfo
  const xTime = x.kind === 'datetime'
  const xUnit = xTime ? null : displayUnit(x.unit, x.field, ctx.settings.units, ctx.activityTypes)
  const yUnit = displayUnit(y.unit, y.field, ctx.settings.units, ctx.activityTypes)
  const xTitle = xTime ? x.label : axisTitle(x.label, xUnit!)
  const aggregated = config.group_by !== 'point' && (config.group_by !== 'activity' || config.y.level !== 'activity')
  const prefix = aggregated ? AGG_PREFIX[config.y.agg ?? 'mean'] : ''
  const yLabel = prefix ? `${prefix} ${y.label[0].toLowerCase()}${y.label.slice(1)}` : y.label
  return { xTime, xUnit, yUnit, xTitle, yTitle: axisTitle(yLabel, yUnit) }
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

export function buildFigure(config: PanelConfig, result: PanelResult, ctx: FigureContext): Figure {
  const { theme } = ctx
  const a = axes(config, result, ctx)
  const isBar = config.chart === 'bar'
  const isScatter = config.chart === 'scatter'
  const yValues: number[] = []
  const xValues: number[] = []

  const data: Data[] = result.series.map((s, i) => {
    const slot = config.series[i]?.color_slot ?? i
    const color = theme.series[slot % theme.series.length]
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
    const hover = isScatter
      ? '<b>%{customdata[0]}</b>%{customdata[1]}<br>%{customdata[4]}<br>%{customdata[3]}<extra>%{fullData.name}</extra>'
      : '<b>%{customdata[0]}</b>%{customdata[1]}  ·  n = %{customdata[2]}<br>%{customdata[3]}<extra></extra>'
    const trace: Data = {
      type: isBar ? 'bar' : 'scatter',
      name: s.label,
      x: xs,
      y: ys,
      customdata: custom,
      hovertemplate: hover,
      marker: isBar
        ? { color }
        : { color, size: isScatter ? 9 : 8, line: { color: theme.surface, width: 2 } },
      ...(isBar ? {} : { mode: isScatter ? 'markers' : 'lines+markers', line: { color, width: 2 } }),
      ...(hasErrors
        ? { error_y: { type: 'data', array: errs, visible: true, color, thickness: 1.5, width: 4 } }
        : {}),
    } as Data
    return trace
  })

  const axisBase = {
    gridcolor: theme.grid,
    linecolor: theme.baseline,
    zeroline: false,
    automargin: true,
    tickfont: { color: theme.muted, size: 11 },
    title: { font: { color: theme.textSecondary, size: 12 } },
  }
  const yaxis: Partial<Layout['yaxis']> = { ...axisBase, title: { ...axisBase.title, text: a.yTitle } }
  if (a.yUnit.format === 'clock' && yValues.length) {
    Object.assign(yaxis, clockAxis(yValues, a.yUnit.reversed))
  } else if (isBar) {
    yaxis.rangemode = 'tozero'
  }
  const xaxis: Partial<Layout['xaxis']> = {
    ...axisBase,
    showline: true,
    showgrid: !a.xTime,
    title: { ...axisBase.title, text: a.xTitle },
  }
  if (a.xTime) {
    Object.assign(xaxis, { type: 'date', hoverformat: xHoverFormat(config) }, dateAxis(config, result))
  } else if (a.xUnit?.format === 'clock' && xValues.length) {
    Object.assign(xaxis, clockAxis(xValues, false))
  }

  const legend = result.series.length >= 2
  const layout: Partial<Layout> = {
    paper_bgcolor: theme.surface,
    plot_bgcolor: theme.surface,
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12, color: theme.textSecondary },
    margin: { l: 8, r: 12, t: legend ? 32 : 8, b: 8 },
    showlegend: legend,
    legend: { orientation: 'h', x: 0, y: 1.02, yanchor: 'bottom', font: { color: theme.textSecondary } },
    hovermode: isScatter ? 'closest' : 'x unified',
    hoverlabel: { bgcolor: theme.surface, bordercolor: theme.grid, font: { color: theme.textPrimary } },
    xaxis,
    yaxis,
    bargap: 0.35,
    bargroupgap: 0.1,
    ...(isBar ? { barcornerradius: 4 } : {}),
  }
  return { data, layout }
}

const DAY_MS = 86_400_000

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

/** Date-axis range and ticks: a sensible minimum span, and ticks on week/month buckets. */
function dateAxis(config: PanelConfig, result: PanelResult): Partial<Layout['xaxis']> {
  const times = result.series.flatMap((s) => s.points.map((p) => wallClockMs(p.x as string)))
  if (!times.length) return {}
  const min = Math.min(...times)
  const max = Math.max(...times)
  if (config.group_by === 'week') {
    const weeks = Math.round((max - min) / (7 * DAY_MS)) + 1
    return {
      tick0: wallClockIso(min),
      dtick: 7 * DAY_MS * Math.max(1, Math.ceil(weeks / 8)),
      tickformat: '%b %-d',
      range: [wallClockIso(min - 4 * DAY_MS), wallClockIso(max + 4 * DAY_MS)],
    }
  }
  if (config.group_by === 'month') {
    const months = Math.round((max - min) / (30.44 * DAY_MS)) + 1
    return {
      tick0: wallClockIso(min),
      dtick: `M${Math.max(1, Math.ceil(months / 8))}`,
      tickformat: '%b %Y',
      range: [wallClockIso(min - 16 * DAY_MS), wallClockIso(max + 16 * DAY_MS)],
    }
  }
  // A single activity (or a few on one day) would otherwise zoom the axis to milliseconds.
  const pad = Math.max((max - min) * 0.04, max - min < 2 * DAY_MS ? 3 * DAY_MS : 0)
  return { range: [wallClockIso(min - pad), wallClockIso(max + pad)] }
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
export function buildTable(config: PanelConfig, result: PanelResult, ctx: FigureContext): TableData {
  const a = axes(config, result, ctx)
  const multi = result.series.length > 1
  const showError = config.error !== 'none'
  const columns = [
    ...(multi ? ['Series'] : []),
    a.xTitle,
    a.yTitle,
    ...(showError ? ['±'] : []),
    'n',
    ...(config.group_by === 'activity' ? ['Activity'] : []),
  ]
  const rows: string[][] = []
  for (const s of result.series) {
    for (const p of s.points) {
      const x = a.xTime ? formatDate(p.x as string, config) : formatValue((p.x as number) * a.xUnit!.factor, a.xUnit!)
      rows.push([
        ...(multi ? [s.label] : []),
        x,
        formatValue(p.y * a.yUnit.factor, a.yUnit),
        ...(showError ? [p.error == null ? '' : formatValue(p.error * a.yUnit.factor, a.yUnit)] : []),
        String(p.n),
        ...(config.group_by === 'activity'
          ? [(p.activity_id && ctx.activityNames?.get(p.activity_id)) || '']
          : []),
      ])
    }
  }
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
