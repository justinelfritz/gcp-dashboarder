import { useEffect, useState } from 'react'
import { api } from './api/client'
import { getOrCreateSessionId } from './api/session'

type ApiStatus = 'checking' | 'ok' | 'error'

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [sessionId, setSessionId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then(() => getOrCreateSessionId())
      .then((id) => {
        if (cancelled) return
        setApiStatus('ok')
        setSessionId(id)
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
        <span className={`status status-${apiStatus}`} data-testid="api-status">
          {apiStatus === 'checking' && 'Connecting to API…'}
          {apiStatus === 'ok' && 'API connected'}
          {apiStatus === 'error' && 'API unavailable'}
        </span>
      </header>
      <main>
        <p>Upload activity files to start building dashboards.</p>
        {sessionId && <p className="status">Session: {sessionId.slice(0, 8)}…</p>}
      </main>
    </>
  )
}
