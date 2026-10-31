// Skip files the API already has: hash each FIT file in the browser and ask which are known, so
// re-uploading a full export sends only the new files.
import { api, MAX_CHECK_HASHES } from '../api/client'

export interface DedupeProgress {
  hashedFiles: number
  totalFiles: number
}

export interface DedupeResult {
  /** Files to upload: new FIT files plus every CSV. */
  files: File[]
  /** FIT files the API has already processed. */
  alreadyStored: number
}

type Checker = (scope: string, hashes: string[]) => Promise<{ known: string[] }>

/**
 * Only FIT files are checked. A CSV's meaning depends on the units and timezone chosen at upload,
 * so the API always re-parses CSVs (they're few and small).
 */
export function isFitFile(f: File): boolean {
  const name = f.name.toLowerCase()
  return name.endsWith('.fit') || name.endsWith('.fit.gz')
}

export async function sha256Hex(f: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await f.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function skipStoredFiles(
  scope: string,
  files: File[],
  onProgress: (p: DedupeProgress) => void = () => {},
  check: Checker = api.checkUploads,
): Promise<DedupeResult> {
  const fit = files.filter(isFitFile)
  if (!fit.length) return { files, alreadyStored: 0 }
  const hashes = new Map<File, string>()
  for (const f of fit) {
    hashes.set(f, await sha256Hex(f))
    if (hashes.size % 50 === 0 || hashes.size === fit.length) {
      onProgress({ hashedFiles: hashes.size, totalFiles: fit.length })
    }
  }
  const unique = [...new Set(hashes.values())]
  const known = new Set<string>()
  try {
    for (let i = 0; i < unique.length; i += MAX_CHECK_HASHES) {
      const resp = await check(scope, unique.slice(i, i + MAX_CHECK_HASHES))
      resp.known.forEach((h) => known.add(h))
    }
  } catch {
    // The check only saves time; if it fails, upload everything and let the API dedupe.
    return { files, alreadyStored: 0 }
  }
  // The same file can appear twice in one export (e.g. nested ZIPs); send it once.
  const sent = new Set<string>()
  const keep = files.filter((f) => {
    const h = hashes.get(f)
    if (h === undefined) return true
    if (known.has(h) || sent.has(h)) return false
    sent.add(h)
    return true
  })
  const alreadyStored = fit.filter((f) => known.has(hashes.get(f)!)).length
  return { files: keep, alreadyStored }
}
