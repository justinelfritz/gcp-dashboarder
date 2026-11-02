import type { Settings } from '../dashboard/types'

export default function UnitsSelect({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  return (
    <label className="inline">
      Units
      <select value={settings.units} onChange={(e) => onSettings({ ...settings, units: e.target.value as Settings['units'] })}>
        <option value="imperial">Imperial</option>
        <option value="metric">Metric</option>
      </select>
    </label>
  )
}
