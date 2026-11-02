import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-basic-dist-min'
import type { PlotlyHTMLElement } from 'plotly.js'
import { ACTIVITY_ID_INDEX } from './buildFigure'
import type { Figure } from './buildFigure'

interface Props {
  figure: Figure
  label: string
  /** Called with the activity of a clicked point; points without one (week, month) do nothing. */
  onOpenActivity?: (activityId: string) => void
}

/** Renders a Plotly figure and keeps it sized to its container (grid panels resize). */
export default function PlotlyChart({ figure, label, onOpenActivity }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const open = useRef(onOpenActivity)
  open.current = onOpenActivity

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // newPlot, not react: Plotly's Home (reset axes) button returns to the ranges recorded on the
    // first draw, and react never re-records them. Redrawing makes Home match the current period.
    void Plotly.newPlot(el, figure.data, { ...figure.layout, autosize: true }, {
      displaylogo: false,
      responsive: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
    }).then((plot: PlotlyHTMLElement) => {
      // newPlot keeps listeners from the previous draw, so replace rather than add.
      plot.removeAllListeners?.('plotly_click')
      plot.on('plotly_click', (e) => {
        const custom = e.points[0]?.customdata as unknown
        const id = Array.isArray(custom) ? custom[ACTIVITY_ID_INDEX] : null
        if (typeof id === 'string' && open.current) open.current(id)
      })
    })
  }, [figure])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.offsetParent !== null) void Plotly.Plots.resize(el)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      Plotly.purge(el)
    }
  }, [])

  return <div ref={ref} className="plot" role="img" aria-label={label} />
}
