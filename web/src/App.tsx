import { useEffect, useState } from 'react'
import { api, ApiError, guestScope, USER_SCOPE } from './api/client'
import type { Scope } from './api/client'
import { forgetSession, getOrCreateSessionId, storedSessionId } from './api/session'
import { useAuth } from './auth/useAuth'
import AccountMenu from './components/AccountMenu'
import DashboardView from './components/DashboardView'
import UploadPanel from './components/UploadPanel'
import { forgetOwner, useDashboards, useSettings } from './dashboard/store'
import { useAccountSync } from './dashboard/sync'

type ApiStatus = 'checking' | 'ok' | 'error'
type Tab = 'dashboard' | 'data'

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const auth = useAuth()
  const [scope, setScope] = useState<Scope | null>(null)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  // Bumped after a guest deletes their data, to start a fresh guest session.
  const [guestEpoch, setGuestEpoch] = useState(0)
  const signedIn = auth.state.status === 'signed-in'
  const owner = auth.state.status === 'signed-in' ? auth.state.user.uid : null
  const store = useDashboards(owner)
  const [settings, setSettings] = useSettings(owner)
  const sync = useAccountSync(owner, store.saved, settings, store.replace, setSettings)
  // Until a new account finishes setup (verified email, authenticator if required), the app stays a guest.
  const authSettled = auth.state.status !== 'loading'

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then(() => !cancelled && setApiStatus('ok'))
      .catch(() => !cancelled && setApiStatus('error'))
    return () => {
      cancelled = true
    }
  }, [])

  // Signed-in users read and write their account's data; everyone else gets a guest session.
  useEffect(() => {
    if (apiStatus !== 'ok' || !authSettled) return
    let cancelled = false
    const pick = signedIn ? Promise.resolve(USER_SCOPE) : getOrCreateSessionId().then(guestScope)
    pick
      .then(async (s) => {
        if (cancelled) return
        setScope(s)
        // With nothing stored yet, start on the upload screen.
        const { total } = await api.activities(s, { limit: 1 })
        if (!cancelled && total === 0) setTab('data')
      })
      // Only a failure to reach the API means it's unavailable; a refused request is shown where
      // it happens.
      .catch((err) => !cancelled && !(err instanceof ApiError) && setApiStatus('error'))
    return () => {
      cancelled = true
    }
  }, [apiStatus, authSettled, signedIn, guestEpoch])

  const deletedAll = async () => {
    setRefreshKey((k) => k + 1)
    if (owner) {
      forgetOwner(owner)
      await auth.signOut() // the account is gone; drop the local sign-in too
    } else {
      forgetSession()
      setScope(null)
      setGuestEpoch((n) => n + 1)
    }
  }

  return (
    <>
      <header className="app-header">
        <h1>Custom Dashboarder</h1>
        {scope && (
          <nav className="tabs" aria-label="Sections">
            {(['data', 'dashboard'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? 'tab tab-active' : 'tab'}
                aria-current={tab === t ? 'page' : undefined}
                onClick={() => setTab(t)}
              >
                {t === 'dashboard' ? 'Dashboard' : 'Load Data'}
              </button>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {sync.status === 'saving' && <span className="status">Saving…</span>}
        {sync.status === 'offline' && (
          <span className="status status-error" title="Changes are kept in this browser and saved when the connection returns">
            Dashboards not saved to account
          </span>
        )}
        <span className={`status status-${apiStatus}`} data-testid="api-status">
          {apiStatus === 'checking' && 'Connecting to API…'}
          {apiStatus === 'ok' && 'API connected'}
          {apiStatus === 'error' && 'API unavailable'}
        </span>
        <AccountMenu auth={auth} />
      </header>
      <main>
        {signedIn && <ClaimGuestData onClaimed={() => setRefreshKey((k) => k + 1)} />}
        {sync.notice && (
          <div className="banner" role="status">
            <p>{sync.notice}</p>
            <button type="button" className="secondary" onClick={sync.dismissNotice}>OK</button>
          </div>
        )}
        {!scope ? (
          <p>Upload activity files to start building dashboards.</p>
        ) : tab === 'data' ? (
          <UploadPanel
            key={scope}
            scope={scope}
            signedIn={signedIn}
            refreshKey={refreshKey}
            defaultUnits={settings.units}
            onUploaded={() => setRefreshKey((k) => k + 1)}
            onDeletedAll={deletedAll}
          />
        ) : (
          <DashboardView
            key={scope}
            scope={scope}
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

/**
 * After sign-in, offer to move what this browser uploaded as a guest into the account, so signing
 * in never loses an upload.
 */
function ClaimGuestData({ onClaimed }: { onClaimed: () => void }) {
  const [guest] = useState(storedSessionId)
  const [count, setCount] = useState(0)
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [result, setResult] = useState('')

  useEffect(() => {
    if (!guest) return
    let cancelled = false
    api
      .library(guestScope(guest))
      .then((lib) => {
        if (cancelled) return
        if (lib.activities) setCount(lib.activities)
        else forgetSession()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [guest])

  if (!guest || (!count && state !== 'done')) return null
  const claim = async () => {
    setState('busy')
    try {
      const r = await api.claimSession(guest)
      forgetSession()
      setResult(
        `Added ${r.activities_added} activities to your account` +
          (r.duplicates_merged ? ` (${r.duplicates_merged} were already there).` : '.'),
      )
      setState('done')
      onClaimed()
    } catch {
      setState('error')
    }
  }
  const discard = () => {
    forgetSession()
    setCount(0)
  }
  return (
    <div className="banner" role="status">
      {state === 'done' ? (
        <p>{result}</p>
      ) : (
        <>
          <p>
            This browser has {count} activities uploaded before you signed in. Add them to your account?
            {state === 'error' && <span className="status-error"> That didn't work; try again.</span>}
          </p>
          <button type="button" disabled={state === 'busy'} onClick={() => void claim()}>Add to my account</button>
          <button type="button" className="secondary" disabled={state === 'busy'} onClick={discard}>
            No, leave them
          </button>
        </>
      )}
    </div>
  )
}
