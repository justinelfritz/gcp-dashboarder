import type { useDashboards } from '../dashboard/store'
import type { DashboardKind, Settings } from '../dashboard/types'
import ActivityView from './ActivityView'
import AggregateView from './AggregateView'

const MODES: { value: DashboardKind; label: string }[] = [
  { value: 'aggregate', label: 'Aggregate activities' },
  { value: 'activity', label: 'Individual activity' },
]

interface Props {
  scope: string
  store: ReturnType<typeof useDashboards>
  settings: Settings
  onSettings: (s: Settings) => void
  refreshKey: number
  mode: DashboardKind
  onMode: (mode: DashboardKind) => void
  /** The activity open in individual mode; null shows the newest. */
  activityId: string | null
  onActivity: (activityId: string) => void
}

/** The Dashboard tab: many activities compared, or one activity inspected. */
export default function DashboardView({ mode, onMode, activityId, onActivity, ...shared }: Props) {
  const modeSwitch = (
    <div className="segmented" role="group" aria-label="Analysis mode">
      {MODES.map((m) => (
        <button key={m.value} type="button" aria-pressed={mode === m.value} onClick={() => onMode(m.value)}>
          {m.label}
        </button>
      ))}
    </div>
  )
  return mode === 'activity' ? (
    <ActivityView {...shared} modeSwitch={modeSwitch} activityId={activityId} onActivity={onActivity} onMode={onMode} />
  ) : (
    <AggregateView
      {...shared}
      modeSwitch={modeSwitch}
      onMode={onMode}
      onOpenActivity={(id) => {
        onActivity(id)
        onMode('activity')
      }}
    />
  )
}
