// Send many files to the API in batches small enough for Cloud Run's 32 MiB request limit.
import { api } from '../api/client'
import type { FileReport, UploadOptions, UploadResponse } from '../api/client'

export interface BatchProgress {
  uploadedFiles: number
  totalFiles: number
}

export interface BatchResult {
  reports: FileReport[]
  totalActivities: number | null
  failedFiles: { name: string; error: string }[]
}

export interface BatchLimits {
  maxBytes: number
  maxFiles: number
}

export const DEFAULT_LIMITS: BatchLimits = { maxBytes: 20 * 1024 * 1024, maxFiles: 50 }

/** Group files into batches under both limits, keeping their order. */
export function makeBatches(files: File[], limits: BatchLimits = DEFAULT_LIMITS): File[][] {
  const batches: File[][] = []
  let current: File[] = []
  let bytes = 0
  for (const f of files) {
    if (current.length && (bytes + f.size > limits.maxBytes || current.length >= limits.maxFiles)) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(f)
    bytes += f.size
  }
  if (current.length) batches.push(current)
  return batches
}

type Uploader = (sessionId: string, files: File[], options: UploadOptions) => Promise<UploadResponse>

/** Upload batches one at a time. A failed batch is reported and the rest still upload. */
export async function uploadInBatches(
  sessionId: string,
  files: File[],
  options: UploadOptions,
  onProgress: (p: BatchProgress) => void = () => {},
  upload: Uploader = api.upload,
  limits: BatchLimits = DEFAULT_LIMITS,
): Promise<BatchResult> {
  const result: BatchResult = { reports: [], totalActivities: null, failedFiles: [] }
  let uploaded = 0
  onProgress({ uploadedFiles: 0, totalFiles: files.length })
  for (const batch of makeBatches(files, limits)) {
    try {
      const resp = await upload(sessionId, batch, options)
      result.reports.push(...resp.files)
      result.totalActivities = resp.total_activities
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result.failedFiles.push(...batch.map((f) => ({ name: f.name, error })))
    }
    uploaded += batch.length
    onProgress({ uploadedFiles: uploaded, totalFiles: files.length })
  }
  return result
}
