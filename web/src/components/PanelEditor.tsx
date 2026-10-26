import { useEffect, useRef, useState } from 'react'
import type { AxisSpec, FieldCatalog, FieldInfo, Level } from '../api/client'
import { currentTheme, SCATTER_SERIES_LIMIT } from '../charts/palette'
import { usesLaps, yAggregates } from '../dashboard/model'
import { AGGREGATIONS, DISTANCE_PRESETS, PALETTE_SIZE } from '../dashboard/types'
import type { PanelConfig, SeriesConfig, Settings } from '../dashboard/types'

const LEVEL_LABELS: Record<Level, string> = {
  activity: 'Activity summary',
  lap: 'Laps / splits',
  record: 'Per-second data',
}

const GROUP_OPTIONS: { value: PanelConfig['group_by']; label: string }[] = [
  { value: 'activity', label: 'One point per activity' },
  { value: 'week', label: 'One point per week' },
  { value: 'month', label: 'One point per month' },
  { value: 'point', label: 'One point per lap or sample' },
]

interface Props {
  panel: PanelConfig
  catalog: FieldCatalog | null
  settings: Settings
  onSave: (p: PanelConfig) => void
  onCancel: () => void
}

export default function PanelEditor({ panel, catalog, settings, onSave, onCancel }: Props) {
  const [p, setP] = useState<PanelConfig>(panel)
  const dialogRef = useRef<HTMLDivElement>(null)
  const set = (patch: Partial<PanelConfig>) => setP((cur) => ({ ...cur, ...patch }))

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const total = catalog?.total_activities ?? 0
  const fieldsAt = (level: Level, axis: 'x' | 'y'): FieldInfo[] =>
    (catalog?.levels[level] ?? []).filter((f) => {
      if (f.kind === 'category') return false
      if (axis === 'y') return f.kind === 'number'
      // Times on x: activity dates when points are activities; lap/record times only per point.
      return f.kind === 'number' || level === 'activity' || p.group_by === 'point'
    })

  const changeLevel = (axis: 'x' | 'y', level: Level) => {
    const current = p[axis]
    const options = fieldsAt(level, axis)
    const keep = options.find((f) => f.name === current.field)
    const pick = keep ?? options.find((f) => f.coverage > 0) ?? options[0]
    const next: AxisSpec = { ...current, level, field: pick?.name ?? current.field }
    const patch: Partial<PanelConfig> = { [axis]: next }
    // Point mode needs one row level; keep the other axis on it (or on activity).
    const other = axis === 'x' ? 'y' : 'x'
    if (p.group_by === 'point' && level !== 'activity' && p[other].level !== 'activity' && p[other].level !== level) {
      const otherOptions = fieldsAt(level, other)
      patch[other] = { ...p[other], level, field: otherOptions[0]?.name ?? p[other].field }
    }
    set(patch)
  }

  const timeGrouped = p.group_by === 'week' || p.group_by === 'month'
  const showYAgg = yAggregates(p)
  const showXAgg = p.group_by === 'activity' && p.x.level !== 'activity'
  const theme = currentTheme()

  const setSeries = (i: number, patch: Partial<SeriesConfig>) =>
    set({ series: p.series.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const addSeries = () => {
    const used = new Set(p.series.map((s) => s.color_slot))
    const slot = [...Array(PALETTE_SIZE).keys()].find((k) => !used.has(k)) ?? 0
    set({ series: [...p.series, { label: `Series ${p.series.length + 1}`, color_slot: slot }] })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" ref={dialogRef}>
        <h2 id="editor-title">Edit panel</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave(p)
          }}
        >
          <label className="field">
            Title
            <input value={p.title} onChange={(e) => set({ title: e.target.value })} />
          </label>

          <fieldset className="row">
            <legend>Chart</legend>
            {(['line', 'scatter', 'bar'] as const).map((c) => (
              <label key={c} className="inline">
                <input type="radio" name="chart" checked={p.chart === c} onChange={() => set({ chart: c })} />
                {c[0].toUpperCase() + c.slice(1)}
              </label>
            ))}
          </fieldset>

          <label className="field">
            Each point is
            <select
              value={p.group_by}
              onChange={(e) => {
                const group_by = e.target.value as PanelConfig['group_by']
                const patch: Partial<PanelConfig> = { group_by }
                if (group_by === 'point' && p.y.level !== 'activity' && p.x.level !== 'activity' && p.x.level !== p.y.level) {
                  patch.x = { ...p.x, level: p.y.level, field: fieldsAt(p.y.level ?? 'activity', 'x')[0]?.name ?? p.x.field }
                }
                set(patch)
              }}
            >
              {GROUP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>

          {!timeGrouped && (
            <AxisFields
              title="X axis"
              axis={p.x}
              fields={fieldsAt(p.x.level ?? 'activity', 'x')}
              total={total}
              showAgg={showXAgg}
              onLevel={(l) => changeLevel('x', l)}
              onChange={(x) => set({ x })}
            />
          )}
          <AxisFields
            title="Y axis"
            axis={p.y}
            fields={fieldsAt(p.y.level ?? 'activity', 'y')}
            total={total}
            showAgg={showYAgg}
            onLevel={(l) => changeLevel('y', l)}
            onChange={(y) => set({ y })}
          />

          {usesLaps(p) && (
            <fieldset className="row">
              <legend>Laps</legend>
              <select value={p.lap_kind} onChange={(e) => set({ lap_kind: e.target.value as PanelConfig['lap_kind'] })}>
                <option value="device">Device laps</option>
                <option value="split_km">Computed 1 km splits</option>
                <option value="split_mi">Computed 1 mile splits</option>
              </select>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={p.include_partial_laps}
                  onChange={(e) => set({ include_partial_laps: e.target.checked })}
                />
                Include the short final lap
              </label>
            </fieldset>
          )}

          <label className="field">
            Error bars
            <select
              value={showYAgg ? p.error : 'none'}
              disabled={!showYAgg}
              onChange={(e) => set({ error: e.target.value as PanelConfig['error'] })}
            >
              <option value="none">None</option>
              <option value="std">Standard deviation</option>
              <option value="sem">Standard error</option>
            </select>
            {!showYAgg && <span className="hint">Needs a lap or per-second y axis, or weekly/monthly points.</span>}
          </label>

          <fieldset>
            <legend>Series</legend>
            {p.series.map((s, i) => (
              <div className="series-row" key={i}>
                <input aria-label={`Series ${i + 1} label`} value={s.label} onChange={(e) => setSeries(i, { label: e.target.value })} />
                <div className="swatches" role="radiogroup" aria-label={`Series ${i + 1} color`}>
                  {theme.series.map((color, slot) => (
                    <button
                      key={slot}
                      type="button"
                      role="radio"
                      aria-checked={s.color_slot === slot}
                      aria-label={`Color ${slot + 1}`}
                      className="swatch"
                      style={{ background: color }}
                      onClick={() => setSeries(i, { color_slot: slot })}
                    />
                  ))}
                </div>
                <select
                  aria-label={`Series ${i + 1} sport`}
                  value={s.activity_type ?? ''}
                  onChange={(e) => setSeries(i, { activity_type: (e.target.value || null) as SeriesConfig['activity_type'] })}
                >
                  <option value="">All sports</option>
                  <option value="run">Runs</option>
                  <option value="ride">Rides</option>
                  <option value="hike">Hikes</option>
                </select>
                <DistancePicker
                  value={s.distance_m ?? null}
                  units={settings.units}
                  tolerance={settings.distance_tolerance}
                  onChange={(distance_m) => setSeries(i, { distance_m })}
                />
                {p.series.length > 1 && (
                  <button type="button" className="link" onClick={() => set({ series: p.series.filter((_, j) => j !== i) })}>
                    Remove
                  </button>
                )}
              </div>
            ))}
            {p.series.length < PALETTE_SIZE && (
              <button type="button" className="secondary" onClick={addSeries}>Add series</button>
            )}
            {p.chart === 'scatter' && p.series.length > SCATTER_SERIES_LIMIT && (
              <p className="hint">
                More than {SCATTER_SERIES_LIMIT} series on a scatter plot are hard to tell apart; use the table view
                or split into another panel.
              </p>
            )}
          </fieldset>

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function AxisFields({ title, axis, fields, total, showAgg, onLevel, onChange }: {
  title: string
  axis: AxisSpec
  fields: FieldInfo[]
  total: number
  showAgg: boolean
  onLevel: (l: Level) => void
  onChange: (a: AxisSpec) => void
}) {
  return (
    <fieldset className="row">
      <legend>{title}</legend>
      <select aria-label={`${title} data`} value={axis.level} onChange={(e) => onLevel(e.target.value as Level)}>
        {(Object.keys(LEVEL_LABELS) as Level[]).map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
      </select>
      <select aria-label={`${title} field`} value={axis.field} onChange={(e) => onChange({ ...axis, field: e.target.value })}>
        {fields.map((f) => (
          <option key={f.name} value={f.name} disabled={f.coverage === 0 && f.name !== axis.field}>
            {f.label} ({f.coverage}/{total})
          </option>
        ))}
      </select>
      {showAgg && (
        <select aria-label={`${title} aggregation`} value={axis.agg ?? 'mean'} onChange={(e) => onChange({ ...axis, agg: e.target.value as AxisSpec['agg'] })}>
          {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
        </select>
      )}
    </fieldset>
  )
}

function DistancePicker({ value, units, tolerance, onChange }: {
  value: number | null
  units: Settings['units']
  tolerance: number
  onChange: (m: number | null) => void
}) {
  const unitM = units === 'imperial' ? 1609.344 : 1000
  const unitLabel = units === 'imperial' ? 'mi' : 'km'
  const preset = DISTANCE_PRESETS.find((d) => value != null && Math.abs(d.meters - value) < 0.5)
  const [custom, setCustom] = useState(value != null && !preset)
  const selectValue = value == null ? '' : preset && !custom ? String(preset.meters) : 'custom'
  return (
    <span className="distance-picker">
      <select
        aria-label="Distance"
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value
          setCustom(v === 'custom')
          if (v === '') onChange(null)
          else if (v !== 'custom') onChange(Number(v))
        }}
      >
        <option value="">Any distance</option>
        {DISTANCE_PRESETS.map((d) => <option key={d.meters} value={d.meters}>{d.label}</option>)}
        <option value="custom">Custom…</option>
      </select>
      {selectValue === 'custom' && (
        <input
          aria-label={`Distance in ${unitLabel}`}
          type="number"
          min="0"
          step="0.1"
          className="narrow"
          value={value != null ? +(value / unitM).toFixed(2) : ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) * unitM : null)}
        />
      )}
      {value != null && <span className="hint">±{(tolerance * 100).toFixed(1)}%</span>}
      {selectValue === 'custom' && <span className="hint">{unitLabel}</span>}
    </span>
  )
}
