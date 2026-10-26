import { lazy, Suspense, useMemo, useState } from 'react'
import type { PanelResult } from '../api/client'
import { buildFigure, buildTable, hasData } from '../charts/buildFigure'
import type { FigureContext } from '../charts/buildFigure'
import type { PanelConfig } from '../dashboard/types'

// Plotly is large; load it only once a chart is on screen.
const PlotlyChart = lazy(() => import('../charts/PlotlyChart'))

interface Props {
  panel: PanelConfig
  result: PanelResult | undefined
  loading: boolean
  ctx: FigureContext
  onEdit: () => void
  onRemove: () => void
}

export default function PanelCard({ panel, result, loading, ctx, onEdit, onRemove }: Props) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const ready = result && !result.error && result.x && result.y
  const figure = useMemo(() => (ready ? buildFigure(panel, result, ctx) : null), [ready, panel, result, ctx])
  // Plotly leaves empty series out of the legend, so say which ones matched nothing.
  const notes = [
    ...(result?.series.length && result.series.length > 1 && hasData(result)
      ? result.series.filter((s) => !s.points.length).map((s) => `${s.label}: no matching activities`)
      : []),
    ...(result?.warnings ?? []),
  ]
  const table = useMemo(() => (ready && view === 'table' ? buildTable(panel, result, ctx) : null), [ready, view, panel, result, ctx])

  return (
    <article className={`panel${loading ? ' panel-loading' : ''}`} aria-busy={loading}>
      <header className="panel-header">
        <h3 className="panel-drag" title="Drag to move">{panel.title}</h3>
        <div className="panel-actions">
          <button type="button" className="link" onClick={() => setView(view === 'chart' ? 'table' : 'chart')}>
            {view === 'chart' ? 'Table' : 'Chart'}
          </button>
          <button type="button" className="link" onClick={onEdit}>Edit</button>
          <button type="button" className="link" onClick={onRemove} aria-label={`Remove ${panel.title}`}>Remove</button>
        </div>
      </header>
      <div className="panel-body">
        {!result ? (
          <p className="empty">Loading…</p>
        ) : result.error ? (
          <p className="empty status-error">This panel can't be drawn: {result.error}</p>
        ) : !hasData(result) ? (
          <p className="empty">No matching activities. Try a longer date range, another distance, or include more activities.</p>
        ) : view === 'table' && table ? (
          <div className="table-wrap">
            <table>
              <thead><tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
              <tbody>
                {table.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        ) : figure ? (
          <Suspense fallback={<p className="empty">Loading chart…</p>}>
            <PlotlyChart figure={figure} label={panel.title} />
          </Suspense>
        ) : null}
      </div>
      {notes.length > 0 && (
        <footer className="panel-warnings">
          {notes.map((w) => <p key={w}>{w}</p>)}
        </footer>
      )}
    </article>
  )
}
