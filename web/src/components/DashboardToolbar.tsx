import { useRef } from 'react'
import type { ReactNode } from 'react'
import { kindOf, starterActivityLayout, starterDashboard } from '../dashboard/model'
import { DashboardImportError, exportDashboard, parseDashboard } from '../dashboard/store'
import type { useDashboards } from '../dashboard/store'
import { newId } from '../dashboard/types'
import type { Dashboard, DashboardKind } from '../dashboard/types'

interface Props {
  store: ReturnType<typeof useDashboards>
  /** The open dashboard (or activity layout); the menu lists only its kind. */
  dashboard: Dashboard
  /** Shown first, before the dashboard menu (the mode switch). */
  lead?: ReactNode
  onAddPanel: () => void
  /** After an import, so the view can switch to the imported item's mode. */
  onImported: (kind: DashboardKind) => void
  onImportError: (message: string | null) => void
}

/** Choose, rename, add, delete, export, and import dashboards (or activity layouts) of one kind. */
export default function DashboardToolbar({ store, dashboard, lead, onAddPanel, onImported, onImportError }: Props) {
  const importRef = useRef<HTMLInputElement>(null)
  const kind = kindOf(dashboard)
  const noun = kind === 'activity' ? 'layout' : 'dashboard'
  const label = kind === 'activity' ? 'Activity layout' : 'Dashboard'
  const sameKind = store.dashboards.filter((d) => kindOf(d) === kind)

  const download = () => {
    const blob = new Blob([exportDashboard(dashboard)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${dashboard.name.replace(/[^\w-]+/g, '_') || noun}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const d = parseDashboard(await file.text())
      store.add(d)
      onImported(kindOf(d))
      onImportError(null)
    } catch (err) {
      onImportError(err instanceof DashboardImportError ? `Import failed: ${err.message}` : 'Import failed')
    }
  }
  const addNew = () => {
    const base = kind === 'activity' ? starterActivityLayout() : starterDashboard()
    store.add({ ...base, id: newId('dash'), name: `New ${noun}`, panels: [] })
  }

  return (
    <div className="toolbar" role="toolbar" aria-label={label}>
      {lead}
      <select aria-label={label} value={dashboard.id} onChange={(e) => store.select(e.target.value)}>
        {sameKind.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button type="button" className="link" onClick={() => {
        const name = window.prompt(`${label} name`, dashboard.name)
        if (name) store.update({ ...dashboard, name: name.slice(0, 80) })
      }}>Rename</button>
      <button type="button" className="link" onClick={addNew}>New</button>
      <button type="button" className="link" onClick={() => {
        if (window.confirm(`Delete "${dashboard.name}"?`)) store.remove(dashboard.id)
      }}>Delete</button>
      <button type="button" className="link" onClick={download}>Export</button>
      <button type="button" className="link" onClick={() => importRef.current?.click()}>Import</button>
      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={(e) => {
        void importFile(e.target.files?.[0])
        e.target.value = ''
      }} />
      <span className="spacer" />
      <button type="button" onClick={onAddPanel}>Add panel</button>
    </div>
  )
}
