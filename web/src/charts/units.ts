// Convert the API's metric values for display. Every conversion is a plain multiplication, so
// error bars scale with the same factor.
import type { ActivityType } from '../api/client'
import type { Settings } from '../dashboard/types'

export type Format = 'number' | 'clock' // clock: seconds shown as m:ss or h:mm:ss

export interface DisplayUnit {
  factor: number
  /** Suffix for axis titles, e.g. "mi" or "min/mi"; empty for unitless values. */
  label: string
  format: Format
  /** Lower is better (pace): plot with the axis reversed so up means faster. */
  reversed: boolean
}

const ELEVATION_FIELDS = new Set(['elevation_gain_m', 'altitude'])

export function displayUnit(
  apiUnit: string,
  field: string,
  units: Settings['units'],
  activityTypes: ActivityType[],
): DisplayUnit {
  const imperial = units === 'imperial'
  const plain = (label: string, factor = 1): DisplayUnit => ({ factor, label, format: 'number', reversed: false })
  switch (apiUnit) {
    case 'm':
      if (ELEVATION_FIELDS.has(field)) return imperial ? plain('ft', 3.28084) : plain('m')
      return imperial ? plain('mi', 1 / 1609.344) : plain('km', 1 / 1000)
    case 's/km':
      return { factor: imperial ? 1.609344 : 1, label: imperial ? 'min/mi' : 'min/km', format: 'clock', reversed: true }
    case 'm/s':
      return imperial ? plain('mph', 2.236936) : plain('km/h', 3.6)
    case 's':
      return { factor: 1, label: '', format: 'clock', reversed: false }
    case 'cadence': {
      const foot = activityTypes.filter((t) => t !== 'ride').length
      const ride = activityTypes.includes('ride')
      return plain(foot && ride ? 'spm / rpm' : ride ? 'rpm' : 'spm')
    }
    default:
      return plain(apiUnit)
  }
}

/** Seconds as m:ss, or h:mm:ss from an hour up. */
export function formatClock(seconds: number): string {
  const sign = seconds < 0 ? '-' : ''
  let s = Math.round(Math.abs(seconds))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  const ss = String(s - m * 60).padStart(2, '0')
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`
}

export function formatNumber(value: number): string {
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function formatValue(value: number, unit: DisplayUnit): string {
  return unit.format === 'clock' ? formatClock(value) : formatNumber(value)
}

const CLOCK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]

/** Evenly spaced ticks on whole clock units (e.g. every 0:15 or 5:00) for [min, max] seconds. */
export function clockTicks(min: number, max: number, target = 7): { vals: number[]; text: string[] } {
  const span = Math.max(max - min, 1)
  const step = CLOCK_STEPS.find((s) => span / s <= target) ?? CLOCK_STEPS[CLOCK_STEPS.length - 1]
  const vals: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) vals.push(v)
  return { vals, text: vals.map(formatClock) }
}

export function axisTitle(label: string, unit: DisplayUnit): string {
  return unit.label ? `${label} (${unit.label})` : label
}
