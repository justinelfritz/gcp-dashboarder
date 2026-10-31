import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { LibrarySummary, Scope, UploadOptions } from '../api/client'
import { signInEnabled } from '../auth/firebase'
import { uploadInBatches } from '../upload/batchUpload'
import type { BatchProgress, BatchResult } from '../upload/batchUpload'
import { skipStoredFiles } from '../upload/dedupe'
import type { DedupeProgress } from '../upload/dedupe'
import { extractActivityFiles } from '../upload/zipImport'

type Status =
  | { step: 'idle' }
  | { step: 'extracting' }
  | { step: 'checking'; progress: DedupeProgress }
  | { step: 'uploading'; progress: BatchProgress }
  | { step: 'done'; result: BatchResult; skipped: string[]; alreadyStored: number }
  | { step: 'error'; message: string }

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export default function UploadPanel({ scope, signedIn = false, refreshKey = 0, defaultUnits = 'imperial', onUploaded, onDeletedAll }: {
  scope: Scope
  /** Signed-in users' uploads are kept; a guest's expire. */
  signedIn?: boolean
  /** Changes when stored data changed elsewhere (e.g. guest uploads claimed), to refresh the summary. */
  refreshKey?: number
  defaultUnits?: NonNullable<UploadOptions['units']>
  onUploaded?: () => void
  /** Called after everything stored for this scope (and, signed in, the account) is deleted. */
  onDeletedAll?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [units, setUnits] = useState<NonNullable<UploadOptions['units']>>(defaultUnits)
  const [timezone, setTimezone] = useState(browserTimezone)
  const [library, setLibrary] = useState<LibrarySummary | null>(null)
  const [libraryKey, setLibraryKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.library(scope).then((l) => !cancelled && setLibrary(l)).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scope, libraryKey, refreshKey])

  async function handleFiles(list: File[]) {
    if (!list.length) return
    try {
      setStatus({ step: 'extracting' })
      const files: File[] = []
      const skipped: string[] = []
      for (const f of list) {
        if (!f.name.toLowerCase().endsWith('.zip')) {
          files.push(f)
          continue
        }
        const found = await extractActivityFiles(f)
        files.push(...found.files)
        if (found.unsupportedActivityFiles)
          skipped.push(`${found.unsupportedActivityFiles} GPX/TCX files (not supported yet)`)
        if (found.tooLarge) skipped.push(`${found.tooLarge} files over 25 MB`)
      }
      if (!files.length) {
        setStatus({ step: 'error', message: 'No FIT or activity CSV files found.' })
        return
      }
      const fresh = await skipStoredFiles(scope, files, (progress) => setStatus({ step: 'checking', progress }))
      const result = await uploadInBatches(scope, fresh.files, { units, timezone }, (progress) =>
        setStatus({ step: 'uploading', progress }),
      )
      setStatus({ step: 'done', result, skipped, alreadyStored: fresh.alreadyStored })
      setLibraryKey((k) => k + 1)
      if (fresh.files.length) onUploaded?.()
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const busy = status.step === 'extracting' || status.step === 'checking' || status.step === 'uploading'
  return (
    <section className="upload-panel">
      <h2>Upload activities</h2>
      <Library library={library} />
      {!signedIn && signInEnabled && (
        <p className="status">
          You’re not signed in: uploads are kept for 7 days in this browser only. Sign in to keep them
          and use them on any device.
        </p>
      )}
      <p className="status">
        A Garmin or Strava export ZIP, FIT files, or a Garmin Connect / Strava activities CSV.
        From a ZIP, only activity files are uploaded.
      </p>
      <div className="upload-options">
        <label>
          Garmin CSV units{' '}
          <select value={units} onChange={(e) => setUnits(e.target.value as typeof units)}>
            <option value="imperial">Imperial (mi, ft)</option>
            <option value="metric">Metric (km, m)</option>
          </select>
        </label>
        <label>
          Timezone <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </label>
      </div>
      <input
        type="file"
        multiple
        accept=".zip,.fit,.gz,.csv"
        disabled={busy}
        aria-label="Activity files"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          // Clear the input so picking the same files again (e.g. an updated export with the same
          // name) still fires a change.
          e.target.value = ''
          void handleFiles(picked)
        }}
      />
      <UploadStatus status={status} />
      <details className="upload-help">
        <summary>Adding new activities without a full export</summary>
        <p>
          Upload any files, at any time: activities already stored are skipped or merged, never
          duplicated. Re-uploading a full export only sends the files that are new.
        </p>
        <ul>
          <li>
            <strong>From your Garmin watch:</strong> connect it by USB and copy the <code>.fit</code> files
            from its <code>GARMIN/Activity</code> folder.
          </li>
          <li>
            <strong>From Garmin Connect:</strong> open an activity, then use the gear menu’s
            “Export Original” (a ZIP holding one FIT file).
          </li>
          <li>
            <strong>From Strava:</strong> open an activity, then use the “…” menu’s “Export Original”.
          </li>
        </ul>
      </details>
      <DataAndPrivacy scope={scope} signedIn={signedIn} hasData={!!library?.activities} onDeleted={onDeletedAll} />
    </section>
  )
}

function DataAndPrivacy({ scope, signedIn, hasData, onDeleted }: {
  scope: Scope
  signedIn: boolean
  hasData: boolean
  onDeleted?: () => void | Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const what = signedIn ? 'your account and everything stored in it' : 'everything uploaded from this browser'

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteAll(scope)
      setConfirming(false)
      await onDeleted?.()
    } catch {
      setError('Deleting failed. Nothing was signed out; try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="upload-help">
      <summary>Your data and privacy</summary>
      <p>
        We store the files you upload (originals, which for GPS devices include your routes) and what we
        compute from them: activity summaries, laps, and per-second data.
        {signedIn
          ? ' Signed in, it’s kept until you delete it, along with your dashboards and settings. Only your account can read it.'
          : ' As a guest, it’s deleted 7 days after upload. Anyone with this browser’s session can read it.'}
        {' '}Delete single activities from a dashboard’s activity list (the “All N activities” button).
      </p>
      {(signedIn || hasData) && (
        <button type="button" className="danger" onClick={() => { setConfirming(true); setTyped('') }}>
          {signedIn ? 'Delete my account and all data' : 'Delete all uploaded data'}
        </button>
      )}
      {confirming && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && setConfirming(false)}>
          <div className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete {signedIn ? 'your account' : 'all data'}?</h2>
            <form onSubmit={(e) => { e.preventDefault(); void remove() }}>
              <p>
                This permanently deletes {what}, including original files. It can’t be undone.
                {signedIn && ' You’ll be signed out, and the account can’t be used again.'}
              </p>
              <label className="field">
                Type DELETE to confirm
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
              </label>
              {error && <p className="status status-error">{error}</p>}
              <div className="modal-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                <button type="submit" className="danger" disabled={busy || typed !== 'DELETE'}>Delete permanently</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </details>
  )
}

function formatDay(day: string): string {
  // A local calendar date; format it in UTC so the viewer's timezone can't shift it.
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric',
  })
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function Library({ library }: { library: LibrarySummary | null }) {
  if (!library) return null
  if (!library.activities) return <p className="status library">Nothing stored yet.</p>
  const hidden = library.activities - library.visible_activities
  return (
    <div className="library" data-testid="library">
      <p>
        <strong>Latest activity: {library.last_date ? formatDay(library.last_date) : '—'}</strong>
      </p>
      <p className="status">
        {library.visible_activities.toLocaleString()} runs, rides, and hikes
        {hidden > 0 && ` (plus ${hidden.toLocaleString()} other activities, stored but not shown)`}
        {library.first_date && ` since ${formatDay(library.first_date)}`}
        {' · '}{library.files_stored.toLocaleString()} original files, {formatBytes(library.bytes_stored)} stored
      </p>
    </div>
  )
}

function UploadStatus({ status }: { status: Status }) {
  switch (status.step) {
    case 'idle':
      return null
    case 'extracting':
      return <p className="status">Reading ZIP…</p>
    case 'checking': {
      const { hashedFiles, totalFiles } = status.progress
      return (
        <p className="status">
          <progress value={hashedFiles} max={totalFiles} /> Checking for files already stored: {hashedFiles} / {totalFiles}
        </p>
      )
    }
    case 'uploading': {
      const { uploadedFiles, totalFiles } = status.progress
      return (
        <p className="status">
          <progress value={uploadedFiles} max={totalFiles} /> {uploadedFiles} / {totalFiles} files
        </p>
      )
    }
    case 'error':
      return <p className="status status-error">{status.message}</p>
    case 'done': {
      const { reports, totalActivities, failedFiles } = status.result
      const sum = (k: 'activities_added' | 'duplicates_merged' | 'rows_rejected') =>
        reports.reduce((n, r) => n + r[k], 0)
      const warnings = [...new Set(reports.flatMap((r) => r.warnings))]
      const rejected = reports.filter((r) => r.activities_parsed === 0 && r.rows_rejected)
      const alreadyStored = status.alreadyStored + reports.filter((r) => r.already_stored).length
      return (
        <div className="status" data-testid="upload-summary">
          <p className="status-ok">
            {reports.length || failedFiles.length
              ? <>
                {sum('activities_added')} activities added, {sum('duplicates_merged')} duplicates
                merged.{totalActivities != null && ` ${totalActivities} activities stored in total.`}
              </>
              : 'Nothing new to upload.'}
          </p>
          {alreadyStored > 0 && <p>{alreadyStored.toLocaleString()} files were already stored and skipped.</p>}
          {status.skipped.map((s) => <p key={s}>Skipped {s}.</p>)}
          {rejected.length > 0 && (
            <p>
              {rejected.length} files rejected, e.g. {rejected[0].filename}:{' '}
              {rejected[0].rejections[0]?.reason}
            </p>
          )}
          {failedFiles.length > 0 && (
            <p className="status-error">
              {failedFiles.length} files failed to upload ({failedFiles[0].error}).
            </p>
          )}
          {warnings.map((w) => <p key={w}>Note: {w}</p>)}
        </div>
      )
    }
  }
}
