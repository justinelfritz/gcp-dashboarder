import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivitySummary, ActivityType } from '../api/client'
import { displayUnit, formatClock } from '../charts/units'
import { activityLabel } from '../dashboard/hooks'
import type { Settings } from '../dashboard/types'
import { dayLabel, localDay, sportLabel } from './activityFormat'

const SPORT_CHIPS: { value: ActivityType; label: string }[] = [
  { value: 'run', label: 'Runs' },
  { value: 'ride', label: 'Rides' },
  { value: 'hike', label: 'Hikes' },
]

interface Props {
  /** Every stored activity, newest first. */
  activities: ActivitySummary[]
  currentId: string | null
  settings: Settings
  onChoose: (activityId: string) => void
  onCancel: () => void
}

/** Pick the one activity to open in individual activity mode. */
export default function ActivityChooser({ activities, currentId, settings, onChoose, onCancel }: Props) {
  const [search, setSearch] = useState('')
  const [sports, setSports] = useState<ActivityType[]>([])
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return activities.filter((a) => {
      if (sports.length && !sports.includes(a.activity_type)) return false
      // Names, or dates as typed in the date column or as YYYY-MM-DD.
      return !q || [activityLabel(a), dayLabel(a), localDay(a)].some((t) => t.toLowerCase().includes(q))
    })
  }, [activities, search, sports])

  const distUnit = displayUnit('m', 'distance_m', settings.units, [])
  const toggleSport = (t: ActivityType) => setSports((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="chooser-title" ref={dialogRef}>
        <h2 id="chooser-title">Open an activity</h2>
        <div className="picker-controls">
          <input type="search" placeholder="Search names or dates" aria-label="Search names or dates" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          {SPORT_CHIPS.map((t) => (
            <button key={t.value} type="button" aria-pressed={sports.includes(t.value)}
              className={sports.includes(t.value) ? 'secondary chip-active' : 'secondary'} onClick={() => toggleSport(t.value)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="table-wrap picker-table">
          {activities.length === 0 ? (
            <p className="empty">No activities yet. Upload some on the Load Data tab.</p>
          ) : shown.length === 0 ? (
            <p className="empty">No activities match the search.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Sport</th>
                  <th className="num">Distance ({distUnit.label})</th>
                  <th className="num">Moving time</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => {
                  const time = a.moving_time_s ?? a.duration_s
                  const current = a.activity_id === currentId
                  return (
                    <tr key={a.activity_id} className={current ? 'row-current' : undefined}>
                      <td>{dayLabel(a)}</td>
                      <td className="picker-name">
                        <button type="button" className="link" aria-current={current || undefined}
                          onClick={() => onChoose(a.activity_id)}>
                          {activityLabel(a)}
                        </button>
                      </td>
                      <td>{sportLabel(a)}</td>
                      <td className="num">{a.distance_m == null ? '–' : (a.distance_m * distUnit.factor).toFixed(2)}</td>
                      <td className="num">{time == null ? '–' : formatClock(time)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-actions">
          <span className="status picker-count" aria-live="polite">
            {shown.length === activities.length ? `${activities.length} activities` : `${shown.length} of ${activities.length} shown`}
          </span>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
