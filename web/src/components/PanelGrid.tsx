import { Responsive, WidthProvider } from 'react-grid-layout'
import type { Layout } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import type { PanelResult } from '../api/client'
import type { FigureContext } from '../charts/buildFigure'
import { Y2_SUFFIX } from '../dashboard/model'
import type { PanelConfig } from '../dashboard/types'
import PanelCard from './PanelCard'

const Grid = WidthProvider(Responsive)

interface Props {
  panels: PanelConfig[]
  results: Map<string, PanelResult>
  loading: boolean
  ctx: FigureContext
  /** Shown in a panel with nothing to draw. */
  emptyMessage?: (p: PanelConfig) => string
  onOpenActivity?: (activityId: string) => void
  onEdit: (p: PanelConfig) => void
  onRemove: (p: PanelConfig) => void
  /** The panels with their new positions, after a drag or resize. */
  onPanels: (panels: PanelConfig[]) => void
}

/** The draggable, resizable grid of panels. */
export default function PanelGrid({ panels, results, loading, ctx, emptyMessage, onOpenActivity, onEdit, onRemove, onPanels }: Props) {
  const onLayoutChange = (_: Layout[], all: { [bp: string]: Layout[] }) => {
    // Only the wide layout is stored; narrow screens stack panels automatically.
    const wide = all.lg
    if (!wide) return
    const byId = new Map(wide.map((l) => [l.i, l]))
    const next = panels.map((p) => {
      const l = byId.get(p.id)
      return l ? { ...p, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : p
    })
    if (JSON.stringify(next) !== JSON.stringify(panels)) onPanels(next)
  }

  return (
    <Grid
      className="grid"
      layouts={{ lg: panels.map((p) => ({ i: p.id, ...p.layout, minW: 3, minH: 4 })) }}
      breakpoints={{ lg: 900, sm: 0 }}
      cols={{ lg: 12, sm: 1 }}
      rowHeight={44}
      margin={[16, 16]}
      containerPadding={[0, 0]}
      draggableHandle=".panel-drag"
      onLayoutChange={onLayoutChange}
    >
      {panels.map((p) => (
        <div key={p.id}>
          <PanelCard
            panel={p}
            result={results.get(p.id)}
            result2={p.y2 ? results.get(p.id + Y2_SUFFIX) : undefined}
            loading={loading}
            ctx={ctx}
            emptyMessage={emptyMessage?.(p)}
            onOpenActivity={onOpenActivity}
            onEdit={() => onEdit(p)}
            onRemove={() => onRemove(p)}
          />
        </div>
      ))}
    </Grid>
  )
}
