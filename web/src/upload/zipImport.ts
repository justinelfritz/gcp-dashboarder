// Extract activity files from an export ZIP in the browser, so only the files the API can use
// leave the user's machine. Handles Strava archives (activities.csv + activities/*.fit.gz) and
// Garmin's full account export (FIT files inside nested UploadedFiles_*.zip archives).
import { BlobReader, BlobWriter, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js'
import type { Entry } from '@zip.js/zip.js'

// Inflate off the main thread where workers exist (browsers); tests run without them.
configure({ useWebWorkers: typeof Worker !== 'undefined' })

/** Matches the API's per-file limit (api/app/config.py max_file_bytes). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_NESTING = 2
const MAX_CSV_BYTES = MAX_FILE_BYTES

export interface ZipImportResult {
  files: File[]
  /** GPX/TCX activity files, which the API doesn't parse yet. */
  unsupportedActivityFiles: number
  tooLarge: number
}

const lower = (name: string) => name.toLowerCase()
const isFit = (name: string) => /\.fit(\.gz)?$/.test(lower(name))
const isZip = (name: string) => lower(name).endsWith('.zip')
const isCsv = (name: string) => lower(name).endsWith('.csv')
const isOtherActivityFile = (name: string) => /\.(gpx|tcx)(\.gz)?$/.test(lower(name))

/** True for the header row of a Garmin Connect or Strava activities export. */
export function isActivityCsvHeader(text: string): boolean {
  const header = text.slice(0, 4096).split(/\r?\n/, 1)[0].replace(/^\uFEFF/, '')
  const cols = new Set(header.split(',').map((c) => c.trim().replace(/^"|"$/g, '')))
  return cols.has('Activity Type') && (cols.has('Date') || cols.has('Activity Date'))
}

/** File name to send: the base name, minus the account email Garmin prefixes to FIT names. */
export function uploadName(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/^[^_/]*@[^_/]*_/, '')
}

export async function extractActivityFiles(zip: Blob): Promise<ZipImportResult> {
  const result: ZipImportResult = { files: [], unsupportedActivityFiles: 0, tooLarge: 0 }
  await walk(zip, 0, result)
  return result
}

async function walk(zip: Blob, depth: number, result: ZipImportResult): Promise<void> {
  const reader = new ZipReader(new BlobReader(zip))
  try {
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue
      await visit(entry, depth, result)
    }
  } finally {
    await reader.close()
  }
}

async function visit(entry: Entry, depth: number, result: ZipImportResult): Promise<void> {
  const name = entry.filename
  if (isZip(name) && depth < MAX_NESTING) {
    // Nested archive: extract it to a Blob and read its entries the same way.
    await walk(await entry.getData!(new BlobWriter()), depth + 1, result)
    return
  }
  if (isOtherActivityFile(name)) {
    result.unsupportedActivityFiles++
    return
  }
  const wanted = isFit(name) || isCsv(name)
  if (!wanted) return
  if (entry.uncompressedSize > (isCsv(name) ? MAX_CSV_BYTES : MAX_FILE_BYTES)) {
    result.tooLarge++
    return
  }
  const bytes = await entry.getData!(new Uint8ArrayWriter())
  if (isCsv(name) && !isActivityCsvHeader(new TextDecoder().decode(bytes.subarray(0, 4096)))) {
    return // some other CSV in the export (comments, profile, ...): never uploaded
  }
  result.files.push(new File([bytes], uploadName(name)))
}
