import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivitySummary } from '../api/client'
import { displayUnit, formatClock } from '../charts/units'
import { activityLabel } from '../dashboard/hooks'
import { ALL_ACTIVITIES, isSelected, setSelected } from '../dashboard/model'
import type { ActivitySelection, Settings } from '../dashboard/types'
import { dayLabel, localDay, sportLabel } from './activityFormat'

interface Props {
  /** Activities matching the dashboard's sport, subtype, and date filters, newest first. */
  activities: ActivitySummary[]
  selection: ActivitySelection | undefined
  settings: Settings
  onApply: (s: ActivitySelection) => void
  onCancel: () => void
  /** Permanently delete a stored activity (not just leave it out of this dashboard). */
  onDelete?: (activityId: string) => Promise<void>
}

export default function ActivityPicker({ activities, selection, settings, onApply, onCancel, onDelete }: Props) {
  const [draft, setDraft] = useState<ActivitySelection>(selection ?? ALL_ACTIVITIES)
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const lastClicked = useRef<number | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const remove = async (a: ActivitySummary) => {
    const ok = window.confirm(
      `Permanently delete “${activityLabel(a)}” from storage, including its original file? ` +
        'To only leave it out of this dashboard, uncheck it instead. Uploading the file again brings it back.',
    )
    if (!ok || !onDelete) return
    setDeleting(a.activity_id)
    setDeleteError(null)
    try {
      await onDelete(a.activity_id)
    } catch {
      setDeleteError(`Couldn’t delete “${activityLabel(a)}”. Try again.`)
    } finally {
      setDeleting(null)
    }
  }
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
      const day = localDay(a)
      if (from && day < from) return false
      if (to && day > to) return false
      return !q || activityLabel(a).toLowerCase().includes(q)
    })
  }, [activities, search, from, to])
  // Reset shift-click anchoring whenever the visible rows change.
  useEffect(() => {
    lastClicked.current = null
  }, [shown])

  const distUnit = displayUnit('m', 'distance_m', settings.units, [])
  const selectedCount = activities.filter((a) => isSelected(draft, a.activity_id)).length
  const shownSelected = shown.filter((a) => isSelected(draft, a.activity_id)).length
  const narrowed = shown.length !== activities.length

  const setShown = (on: boolean) => setDraft((d) => setSelected(d, shown.map((a) => a.activity_id), on))
  const toggle = (index: number, on: boolean, shift: boolean) => {
    const anchor = lastClicked.current
    // Shift-click applies the clicked row's new state to every row since the last click.
    const [lo, hi] = shift && anchor !== null ? [Math.min(anchor, index), Math.max(anchor, index)] : [index, index]
    setDraft((d) => setSelected(d, shown.slice(lo, hi + 1).map((a) => a.activity_id), on))
    lastClicked.current = index
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="picker-title" ref={dialogRef}>
        <h2 id="picker-title">Activities to analyze</h2>
        <p className="picker-note">
          Showing activities that match this dashboard’s sports and date range.
          {draft.mode === 'all'
            ? ' Unchecked activities are left out; new uploads are included automatically.'
            : ' Only checked activities are analyzed; new uploads are not included.'}
        </p>

        <div className="picker-controls">
          <input type="search" placeholder="Search names" aria-label="Search names" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          <label className="inline">
            From
            <input type="date" aria-label="Show from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="inline">
            to
            <input type="date" aria-label="Show to" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {(search || from || to) && (
            <button type="button" className="link" onClick={() => { setSearch(''); setFrom(''); setTo('') }}>
              Show all
            </button>
          )}
        </div>

        <div className="picker-controls">
          <button type="button" className="secondary" disabled={!shown.length} onClick={() => setShown(true)}>
            Check {narrowed ? `shown (${shown.length})` : 'all'}
          </button>
          <button type="button" className="secondary" disabled={!shown.length} onClick={() => setShown(false)}>
            Uncheck {narrowed ? `shown (${shown.length})` : 'all'}
          </button>
          <span className="spacer" />
          <button type="button" className="link" onClick={() => setDraft({ mode: 'only', ids: [] })}
            title="Start from nothing, then check the activities to analyze">
            Pick individually
          </button>
          <button type="button" className="link" onClick={() => setDraft(ALL_ACTIVITIES)}
            title="Analyze every matching activity, including future uploads">
            Reset to all
          </button>
        </div>

        <div className="table-wrap picker-table">
          {activities.length === 0 ? (
            <p className="empty">No activities match this dashboard’s sports and date range.</p>
          ) : shown.length === 0 ? (
            <p className="empty">No activities match the search.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Check all shown"
                      checked={shown.length > 0 && shownSelected === shown.length}
                      ref={(el) => {
                        if (el) el.indeterminate = shownSelected > 0 && shownSelected < shown.length
                      }}
                      onChange={(e) => setShown(e.target.checked)}
                    />
                  </th>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Sport</th>
                  <th className="num">Distance ({distUnit.label})</th>
                  <th className="num">Moving time</th>
                  {onDelete && <th><span className="visually-hidden">Delete</span></th>}
                </tr>
              </thead>
              <tbody>
                {shown.map((a, i) => {
                  const on = isSelected(draft, a.activity_id)
                  const time = a.moving_time_s ?? a.duration_s
                  return (
                    <tr key={a.activity_id} className={on ? undefined : 'row-off'}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Include ${activityLabel(a)}`}
                          checked={on}
                          // onClick rather than onChange: only the click event carries shiftKey.
                          // Space on a focused checkbox fires a click too.
                          onClick={(e) => toggle(i, e.currentTarget.checked, e.shiftKey)}
                          onChange={() => {}}
                        />
                      </td>
                      <td>{dayLabel(a)}</td>
                      <td className="picker-name">{activityLabel(a)}</td>
                      <td>{sportLabel(a)}</td>
                      <td className="num">{a.distance_m == null ? '–' : (a.distance_m * distUnit.factor).toFixed(2)}</td>
                      <td className="num">{time == null ? '–' : formatClock(time)}</td>
                      {onDelete && (
                        <td>
                          <button type="button" className="link danger" disabled={deleting !== null}
                            aria-label={`Delete ${activityLabel(a)} permanently`} onClick={() => void remove(a)}>
                            {deleting === a.activity_id ? 'Deleting…' : 'Delete'}
                          </button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {deleteError && <p className="status status-error">{deleteError}</p>}
        <div className="modal-actions">
          <span className="status picker-count" aria-live="polite">
            {selectedCount} of {activities.length} selected{narrowed ? ` · ${shownSelected} of ${shown.length} shown` : ''}
          </span>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={() => onApply(draft)}>Apply</button>
        </div>
      </div>
    </div>
  )
}
