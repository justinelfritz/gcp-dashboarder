// Keep a signed-in user's dashboards and settings in their account, so every device sees them.
import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../api/client'
import type { DashboardsDocument } from '../api/client'
import { fromAccountDocument, toAccountDocument } from './store'
import type { Saved } from './store'
import type { Settings } from './types'

const SAVE_DELAY_MS = 800

export type SyncStatus = 'off' | 'loading' | 'saving' | 'saved' | 'offline'

/**
 * On sign-in, load the account's copy (or upload this browser's, the first time). After that, save
 * every change, debounced and one at a time. If another device saved in between, the server
 * refuses the save; the newer copy is shown instead, with a notice.
 */
export function useAccountSync(
  owner: string | null,
  saved: Saved,
  settings: Settings,
  replace: (s: Saved) => void,
  setSettings: (s: Settings) => void,
) {
  const [status, setStatus] = useState<SyncStatus>('off')
  const [notice, setNotice] = useState<string | null>(null)
  // The owner whose account copy has been loaded; saving waits for it.
  const [loaded, setLoaded] = useState<string | null>(null)
  const generation = useRef(0)
  // The document as the server has it, to skip saves that change nothing.
  const synced = useRef<string | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const apply = useRef({ replace, setSettings })
  apply.current = { replace, setSettings }

  const adopt = useRef((r: DashboardsDocument) => {
    generation.current = r.generation
    const parsed = fromAccountDocument(r.document)
    if (!parsed) {
      // Nothing saved yet (or unreadable): this browser's copy gets uploaded.
      synced.current = ''
      return
    }
    apply.current.replace(parsed.saved)
    apply.current.setSettings(parsed.settings)
    synced.current = JSON.stringify(toAccountDocument(parsed.saved, parsed.settings))
  })

  useEffect(() => {
    synced.current = null
    setLoaded(null)
    setNotice(null)
    if (!owner) {
      setStatus('off')
      return
    }
    let cancelled = false
    setStatus('loading')
    api
      .getDashboards()
      .then((r) => {
        if (cancelled) return
        adopt.current(r)
        setLoaded(owner)
        setStatus('saved')
      })
      .catch(() => !cancelled && setStatus('offline'))
    return () => {
      cancelled = true
    }
  }, [owner])

  useEffect(() => {
    if (!owner || loaded !== owner) return
    const doc = toAccountDocument(saved, settings)
    const body = JSON.stringify(doc)
    if (body === synced.current) return
    setStatus('saving')
    const timer = setTimeout(() => {
      // One save at a time, each based on the generation the previous one produced.
      queue.current = queue.current.then(async () => {
        if (body === synced.current) return
        try {
          const r = await api.saveDashboards(doc as unknown as Record<string, unknown>, generation.current)
          generation.current = r.generation
          synced.current = body
          setStatus('saved')
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.body) {
            adopt.current(err.body as DashboardsDocument)
            setNotice('Your dashboards were changed on another device, so this device now shows that version.')
            setStatus('saved')
          } else {
            // Kept in this browser; the next change retries.
            setStatus('offline')
          }
        }
      })
    }, SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [owner, loaded, saved, settings])

  return { status, notice, dismissNotice: () => setNotice(null) }
}
