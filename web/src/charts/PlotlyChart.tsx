import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-basic-dist-min'
import type { Figure } from './buildFigure'

/** Renders a Plotly figure and keeps it sized to its container (grid panels resize). */
export default function PlotlyChart({ figure, label }: { figure: Figure; label: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    void Plotly.react(el, figure.data, { ...figure.layout, autosize: true }, {
      displaylogo: false,
      responsive: true,
      modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
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
