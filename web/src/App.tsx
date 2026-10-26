import { useEffect, useState } from 'react'
import { api } from './api/client'
import { getOrCreateSessionId } from './api/session'
import DashboardView from './components/DashboardView'
import UploadPanel from './components/UploadPanel'
import { useDashboards, useSettings } from './dashboard/store'

type ApiStatus = 'checking' | 'ok' | 'error'
type Tab = 'dashboard' | 'data'

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const store = useDashboards()
  const [settings, setSettings] = useSettings()

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then(() => getOrCreateSessionId())
      .then(async (id) => {
        if (cancelled) return
        setApiStatus('ok')
        setSessionId(id)
        // New sessions start on the upload screen.
        const { total } = await api.activities(id, { limit: 1 })
        if (!cancelled && total === 0) setTab('data')
      })
      .catch(() => {
        if (!cancelled) setApiStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <header className="app-header">
        <h1>Dashboarder</h1>
        {sessionId && (
          <nav className="tabs" aria-label="Sections">
            {(['dashboard', 'data'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? 'tab tab-active' : 'tab'}
                aria-current={tab === t ? 'page' : undefined}
                onClick={() => setTab(t)}
              >
                {t === 'dashboard' ? 'Dashboard' : 'Data'}
              </button>
            ))}
          </nav>
        )}
        <span className={`status status-${apiStatus}`} data-testid="api-status">
          {apiStatus === 'checking' && 'Connecting to API…'}
          {apiStatus === 'ok' && 'API connected'}
          {apiStatus === 'error' && 'API unavailable'}
        </span>
      </header>
      <main>
        {!sessionId ? (
          <p>Upload activity files to start building dashboards.</p>
        ) : tab === 'data' ? (
          <UploadPanel
            sessionId={sessionId}
            defaultUnits={settings.units}
            onUploaded={() => setRefreshKey((k) => k + 1)}
          />
        ) : (
          <DashboardView
            sessionId={sessionId}
            store={store}
            settings={settings}
            onSettings={setSettings}
            refreshKey={refreshKey}
          />
        )}
      </main>
    </>
  )
}
