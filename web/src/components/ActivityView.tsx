import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { FieldCatalog } from '../api/client'
import type { FigureContext } from '../charts/buildFigure'
import { currentTheme } from '../charts/palette'
import { activityLabel, useActivities, useFieldCatalog, usePanelResults } from '../dashboard/hooks'
import { blankActivityPanel } from '../dashboard/model'
import type { useDashboards } from '../dashboard/store'
import type { Dashboard, DashboardFilters, DashboardKind, PanelConfig, Settings } from '../dashboard/types'
import ActivityChooser from './ActivityChooser'
import ActivityStats from './ActivityStats'
import DashboardToolbar from './DashboardToolbar'
import PanelEditor from './PanelEditor'
import PanelGrid from './PanelGrid'
import { startLabel, sportLabel } from './activityFormat'
import UnitsSelect from './UnitsSelect'

// Every stored activity can be opened, whatever its sport or date.
const EVERY_ACTIVITY: DashboardFilters = { activity_types: ['run', 'ride', 'hike'], date_preset: 'all' }

interface Props {
  scope: string
  store: ReturnType<typeof useDashboards>
  settings: Settings
  onSettings: (s: Settings) => void
  refreshKey: number
  modeSwitch: ReactNode
  /** The activity to show; null (or one that's gone) shows the newest. */
  activityId: string | null
  onActivity: (activityId: string) => void
  onMode: (kind: DashboardKind) => void
}

/** Individual activity mode: one activity's summary, then the open layout's panels drawn for it. */
export default function ActivityView({ scope, store, settings, onSettings, refreshKey, modeSwitch, activityId, onActivity, onMode }: Props) {
  const layout = store.activeLayout
  const activities = useActivities(scope, EVERY_ACTIVITY, refreshKey)
  const items = activities.items
  // Until the list loads, trust the id (e.g. a point just clicked); then fall back to the newest.
  const known = activityId && (!activities.loaded || items.some((a) => a.activity_id === activityId))
  const openId = known ? activityId : items[0]?.activity_id ?? null
  const index = items.findIndex((a) => a.activity_id === openId)
  const activity = index >= 0 ? items[index] : null

  const { results, loading, error } = usePanelResults(scope, layout, settings, refreshKey, openId)
  const catalog = useFieldCatalog(scope, EVERY_ACTIVITY.activity_types, refreshKey)
  const [editing, setEditing] = useState<PanelConfig | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

  const sport = activity?.activity_type
  const ctx: FigureContext = useMemo(
    () => ({ settings, activityTypes: sport ? [sport] : [], theme: currentTheme() }),
    [settings, sport],
  )
  const update = (patch: Partial<Dashboard>) => store.update({ ...layout, ...patch })
  const savePanel = (p: PanelConfig) => {
    const exists = layout.panels.some((q) => q.id === p.id)
    update({ panels: exists ? layout.panels.map((q) => (q.id === p.id ? p : q)) : [...layout.panels, p] })
    setEditing(null)
  }
  const lowestRow = Math.max(0, ...layout.panels.map((p) => p.layout.y + p.layout.h))
  const older = index >= 0 ? items[index + 1] : undefined
  const newer = index > 0 ? items[index - 1] : undefined

  return (
    <div className="dashboard">
      <DashboardToolbar
        store={store}
        dashboard={layout}
        lead={modeSwitch}
        onAddPanel={() => setEditing(blankActivityPanel(lowestRow))}
        onImported={onMode}
        onImportError={setImportError}
      />

      <div className="filters activity-header" role="group" aria-label="Activity">
        {activity ? (
          <div className="activity-title">
            <h2>{activityLabel(activity)}</h2>
            <p className="status">{startLabel(activity)} · {sportLabel(activity)}</p>
          </div>
        ) : (
          <p className="status">{activities.loaded ? 'No activities yet.' : 'Loading activities…'}</p>
        )}
        <span className="spacer" />
        <button type="button" className="secondary" disabled={!older} onClick={() => older && onActivity(older.activity_id)}>
          ← Older
        </button>
        <button type="button" className="secondary" disabled={!newer} onClick={() => newer && onActivity(newer.activity_id)}>
          Newer →
        </button>
        <button type="button" className="secondary" disabled={!activities.loaded} onClick={() => setChoosing(true)}>
          Choose activity
        </button>
        <UnitsSelect settings={settings} onSettings={onSettings} />
      </div>

      {(error || importError) && <p className="status status-error" role="alert">{importError ?? `Couldn't load data: ${error}`}</p>}

      {activities.loaded && !items.length ? (
        <p className="empty">Upload activities on the Load Data tab, then open them here one at a time.</p>
      ) : (
        <>
          {activity && <ActivityStats activity={activity} units={settings.units} />}
          {activity && !activity.has_records ? (
            <p className="empty">
              This activity has summary data only, so there's nothing to chart. Upload its FIT file to see its laps and samples.
            </p>
          ) : layout.panels.length === 0 ? (
            <p className="empty">No panels yet. Use “Add panel” to chart this activity’s laps or samples.</p>
          ) : (
            <PanelGrid
              panels={layout.panels}
              results={results}
              loading={loading}
              ctx={ctx}
              emptyMessage={(p) => `This activity has no ${fieldLabel(catalog, p).toLowerCase()} data.`}
              onEdit={setEditing}
              onRemove={(p) => update({ panels: layout.panels.filter((q) => q.id !== p.id) })}
              onPanels={(panels) => update({ panels })}
            />
          )}
        </>
      )}

      {choosing && (
        <ActivityChooser
          activities={items}
          currentId={openId}
          settings={settings}
          onChoose={(id) => {
            onActivity(id)
            setChoosing(false)
          }}
          onCancel={() => setChoosing(false)}
        />
      )}

      {editing && (
        <PanelEditor
          panel={editing}
          catalog={catalog}
          settings={settings}
          single
          onSave={savePanel}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}

/** The y quantity's name, e.g. "Heart rate". */
function fieldLabel(catalog: FieldCatalog | null, p: PanelConfig): string {
  const level = p.y.level ?? 'activity'
  return catalog?.levels[level]?.find((f) => f.name === p.y.field)?.label ?? p.y.field.replace(/_/g, ' ')
}
