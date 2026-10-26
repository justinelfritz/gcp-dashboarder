import { useState } from 'react'
import type { UploadOptions } from '../api/client'
import { uploadInBatches } from '../upload/batchUpload'
import type { BatchProgress, BatchResult } from '../upload/batchUpload'
import { extractActivityFiles } from '../upload/zipImport'

type Status =
  | { step: 'idle' }
  | { step: 'extracting' }
  | { step: 'uploading'; progress: BatchProgress }
  | { step: 'done'; result: BatchResult; skipped: string[] }
  | { step: 'error'; message: string }

const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export default function UploadPanel({ sessionId, defaultUnits = 'imperial', onUploaded }: {
  sessionId: string
  defaultUnits?: NonNullable<UploadOptions['units']>
  onUploaded?: () => void
}) {
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [units, setUnits] = useState<NonNullable<UploadOptions['units']>>(defaultUnits)
  const [timezone, setTimezone] = useState(browserTimezone)

  async function handleFiles(list: FileList | null) {
    if (!list?.length) return
    try {
      setStatus({ step: 'extracting' })
      const files: File[] = []
      const skipped: string[] = []
      for (const f of Array.from(list)) {
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
      const result = await uploadInBatches(sessionId, files, { units, timezone }, (progress) =>
        setStatus({ step: 'uploading', progress }),
      )
      setStatus({ step: 'done', result, skipped })
      onUploaded?.()
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const busy = status.step === 'extracting' || status.step === 'uploading'
  return (
    <section className="upload-panel">
      <h2>Upload activities</h2>
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
        onChange={(e) => handleFiles(e.target.files)}
      />
      <UploadStatus status={status} />
    </section>
  )
}

function UploadStatus({ status }: { status: Status }) {
  switch (status.step) {
    case 'idle':
      return null
    case 'extracting':
      return <p className="status">Reading ZIP…</p>
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
      return (
        <div className="status" data-testid="upload-summary">
          <p className="status-ok">
            {sum('activities_added')} activities added, {sum('duplicates_merged')} duplicates
            merged. {totalActivities ?? '—'} activities stored in total.
          </p>
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
