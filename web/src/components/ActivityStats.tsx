import type { ActivitySummary } from '../api/client'
import { displayUnit, formatClock, formatValue } from '../charts/units'
import type { Settings } from '../dashboard/types'

interface Tile {
  label: string
  value: string
  unit: string
  sub?: string
}

/** The activity's headline numbers; a number the file doesn't have is left out, not shown as zero. */
function statTiles(a: ActivitySummary, units: Settings['units']): Tile[] {
  const types = [a.activity_type]
  const tile = (label: string, value: number | null, apiUnit: string, field: string, sub?: string): Tile[] => {
    if (value == null || !Number.isFinite(value)) return []
    const u = displayUnit(apiUnit, field, units, types)
    return [{ label, value: formatValue(value * u.factor, u), unit: u.label, ...(sub ? { sub } : {}) }]
  }
  const moving = a.moving_time_s ?? a.duration_s
  const elapsed = a.duration_s != null && a.moving_time_s != null && Math.round(a.duration_s) !== Math.round(a.moving_time_s)
    ? `${formatClock(a.duration_s)} elapsed`
    : undefined
  // Pace from moving time, as the API derives it, so stops don't slow it.
  const pace = moving && a.distance_m ? moving / (a.distance_m / 1000) : null
  return [
    ...tile('Distance', a.distance_m, 'm', 'distance_m'),
    ...tile('Moving time', moving, 's', 'moving_time_s', elapsed),
    ...(a.activity_type === 'ride'
      ? tile('Average speed', a.avg_speed_mps, 'm/s', 'avg_speed_mps')
      : tile('Average pace', pace, 's/km', 'avg_pace_s_per_km')),
    ...tile('Elevation gain', a.elevation_gain_m, 'm', 'elevation_gain_m'),
    ...tile('Average heart rate', a.avg_hr, 'bpm', 'avg_hr'),
    ...tile('Average cadence', a.avg_cadence, 'cadence', 'avg_cadence'),
    ...tile('Average power', a.avg_power_w, 'W', 'avg_power_w'),
  ]
}

export default function ActivityStats({ activity, units }: { activity: ActivitySummary; units: Settings['units'] }) {
  const tiles = statTiles(activity, units)
  if (!tiles.length) return null
  return (
    <dl className="stat-row" aria-label="Activity summary">
      {tiles.map((t) => (
        <div className="stat-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>
            <span className="stat-value">{t.value}</span>
            {t.unit && <span className="stat-unit"> {t.unit}</span>}
            {t.sub && <span className="stat-sub">{t.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}
