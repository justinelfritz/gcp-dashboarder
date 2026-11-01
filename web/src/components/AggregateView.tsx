import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { api, STANDARD_SUBTYPE_HINT, subtypeLabel } from '../api/client'
import type { ActivitySubtype, ActivityType } from '../api/client'
import type { FigureContext } from '../charts/buildFigure'
import { currentTheme } from '../charts/palette'
import { activityLabel, useActivities, useFieldCatalog, usePanelResults } from '../dashboard/hooks'
import { blankPanel, dateWindow, isSelected, retitleForTypes } from '../dashboard/model'
import type { useDashboards } from '../dashboard/store'
import type { Dashboard, DashboardKind, DatePreset, PanelConfig, Settings } from '../dashboard/types'
import ActivityPicker from './ActivityPicker'
import DashboardToolbar from './DashboardToolbar'
import PanelEditor from './PanelEditor'
import PanelGrid from './PanelGrid'
import UnitsSelect from './UnitsSelect'

const TYPES: { value: ActivityType; label: string }[] = [
  { value: 'run', label: 'Runs' },
  { value: 'ride', label: 'Rides' },
  { value: 'hike', label: 'Hikes' },
]
const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_60', label: 'Last 60 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'last_180', label: 'Last 6 months' },
  { value: 'last_365', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
]

interface Props {
  scope: string
  store: ReturnType<typeof useDashboards>
  settings: Settings
  onSettings: (s: Settings) => void
  refreshKey: number
  /** The mode switch, shown at the start of the toolbar. */
  modeSwitch: ReactNode
  /** Clicking a point opens its activity in individual activity mode. */
  onOpenActivity: (activityId: string) => void
  onMode: (kind: DashboardKind) => void
}

/** Aggregate mode: many activities, chosen by sport, subtype, date, and hand-picked selection. */
export default function AggregateView({ scope, store, settings, onSettings, refreshKey: outerRefresh, modeSwitch, onOpenActivity, onMode }: Props) {
  const dashboard = store.active
  // Deleting an activity here changes stored data too, so refetch as after an upload.
  const [deletions, setDeletions] = useState(0)
  // Both only ever increase, so their sum changes whenever either does.
  const refreshKey = outerRefresh + deletions
  const { results, loading, error } = usePanelResults(scope, dashboard, settings, refreshKey)
  const catalog = useFieldCatalog(scope, dashboard.filters.activity_types, refreshKey)
  const activities = useActivities(scope, dashboard.filters, refreshKey)
  const activityNames = useMemo(
    () => new Map(activities.items.map((a) => [a.activity_id, activityLabel(a)])),
    [activities.items],
  )
  const selection = dashboard.filters.selection
  const selectedCount = activities.items.filter((a) => isSelected(selection, a.activity_id)).length
  const [editing, setEditing] = useState<PanelConfig | null>(null)
  const [picking, setPicking] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const { date_preset: preset, start, end } = dashboard.filters
  const ctx: FigureContext = useMemo(
    () => ({
      settings,
      activityTypes: dashboard.filters.activity_types,
      theme: currentTheme(),
      activityNames,
      dateWindow: dateWindow({ activity_types: [], date_preset: preset, start, end }),
      openable: true,
    }),
    [settings, dashboard.filters.activity_types, activityNames, preset, start, end],
  )

  const update = (patch: Partial<Dashboard>) => store.update({ ...dashboard, ...patch })
  const setFilters = (patch: Partial<Dashboard['filters']>) => update({ filters: { ...dashboard.filters, ...patch } })
  const savePanel = (p: PanelConfig) => {
    const exists = dashboard.panels.some((q) => q.id === p.id)
    update({ panels: exists ? dashboard.panels.map((q) => (q.id === p.id ? p : q)) : [...dashboard.panels, p] })
    setEditing(null)
  }
  const lowestRow = Math.max(0, ...dashboard.panels.map((p) => p.layout.y + p.layout.h))

  return (
    <div className="dashboard">
      <DashboardToolbar
        store={store}
        dashboard={dashboard}
        lead={modeSwitch}
        onAddPanel={() => setEditing(blankPanel(lowestRow))}
        onImported={onMode}
        onImportError={setImportError}
      />

      <div className="filters" role="group" aria-label="Filters">
        <select aria-label="Date range" value={dashboard.filters.date_preset}
          onChange={(e) => setFilters({ date_preset: e.target.value as DatePreset })}>
          {DATE_PRESETS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        {dashboard.filters.date_preset === 'custom' && (
          <>
            <input type="date" aria-label="Start date" value={dashboard.filters.start ?? ''}
              onChange={(e) => setFilters({ start: e.target.value })} />
            <input type="date" aria-label="End date" value={dashboard.filters.end ?? ''}
              onChange={(e) => setFilters({ end: e.target.value })} />
          </>
        )}
        {TYPES.map((t) => (
          <label key={t.value} className="inline">
            <input
              type="checkbox"
              checked={dashboard.filters.activity_types.includes(t.value)}
              onChange={(e) => {
                const types = e.target.checked
                  ? [...dashboard.filters.activity_types, t.value]
                  : dashboard.filters.activity_types.filter((x) => x !== t.value)
                if (types.length) {
                  update({
                    filters: { ...dashboard.filters, activity_types: types },
                    panels: retitleForTypes(dashboard.panels, types),
                  })
                }
              }}
            />
            {t.label}
          </label>
        ))}
        {TYPES.filter((t) => dashboard.filters.activity_types.includes(t.value)).map((t) => {
          // Offered once the data has more than one subtype for the sport (trail and standard runs).
          const counts = catalog?.subtypes?.[t.value] ?? {}
          const chosen = dashboard.filters.activity_subtypes?.[t.value]?.[0] ?? ''
          const options = Object.keys(counts) as ActivitySubtype[]
          if (options.length < 2 && !chosen) return null
          return (
            <select
              key={t.value}
              aria-label={`${t.label} subtype`}
              title={STANDARD_SUBTYPE_HINT}
              className={chosen ? 'chip-active' : undefined}
              value={chosen}
              onChange={(e) => {
                const rest = { ...dashboard.filters.activity_subtypes }
                if (e.target.value) rest[t.value] = [e.target.value as ActivitySubtype]
                else delete rest[t.value]
                setFilters({ activity_subtypes: Object.keys(rest).length ? rest : undefined })
              }}
            >
              <option value="">All {t.label.toLowerCase()}</option>
              {chosen && !options.includes(chosen as ActivitySubtype) && (
                <option value={chosen}>{subtypeLabel(chosen)} {t.label.toLowerCase()} (0)</option>
              )}
              {options.map((s) => (
                <option key={s} value={s}>{subtypeLabel(s)} {t.label.toLowerCase()} ({counts[s]})</option>
              ))}
            </select>
          )
        })}
        <button
          type="button"
          className={selectedCount < activities.items.length || selection?.mode === 'only' ? 'secondary chip-active' : 'secondary'}
          onClick={() => setPicking(true)}
          disabled={!activities.loaded}
        >
          {selectedCount === activities.items.length
            ? `All ${activities.items.length} activities`
            : `${selectedCount} of ${activities.items.length} activities`}
        </button>
        <span className="spacer" />
        <UnitsSelect settings={settings} onSettings={onSettings} />
        <label className="inline">
          Distance match ±
          <input
            type="number"
            className="narrow"
            min="0"
            max="50"
            step="0.5"
            value={+(settings.distance_tolerance * 100).toFixed(1)}
            onChange={(e) => {
              const pct = Number(e.target.value)
              if (Number.isFinite(pct) && pct >= 0 && pct <= 50) onSettings({ ...settings, distance_tolerance: pct / 100 })
            }}
          />
          %
        </label>
      </div>

      {(error || importError) && <p className="status status-error" role="alert">{importError ?? `Couldn't load data: ${error}`}</p>}

      {dashboard.panels.length === 0 ? (
        <p className="empty">No panels yet. Use “Add panel” to build your first chart.</p>
      ) : (
        <PanelGrid
          panels={dashboard.panels}
          results={results}
          loading={loading}
          ctx={ctx}
          onOpenActivity={onOpenActivity}
          onEdit={setEditing}
          onRemove={(p) => update({ panels: dashboard.panels.filter((q) => q.id !== p.id) })}
          onPanels={(panels) => update({ panels })}
        />
      )}

      {picking && (
        <ActivityPicker
          activities={activities.items}
          selection={selection}
          settings={settings}
          onApply={(sel) => {
            // "Everything" is stored as no selection, so the dashboard JSON stays minimal.
            const all = sel.mode === 'all' && sel.ids.length === 0
            update({ filters: { ...dashboard.filters, selection: all ? undefined : sel } })
            setPicking(false)
          }}
          onCancel={() => setPicking(false)}
          onDelete={async (activityId) => {
            await api.deleteActivity(scope, activityId)
            setDeletions((n) => n + 1)
          }}
        />
      )}

      {editing && (
        <PanelEditor
          panel={editing}
          catalog={catalog}
          settings={settings}
          onSave={savePanel}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
