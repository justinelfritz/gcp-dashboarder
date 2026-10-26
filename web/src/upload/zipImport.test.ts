// @vitest-environment node
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'
import { extractActivityFiles, isActivityCsvHeader, uploadName } from './zipImport'

// Bytes 8-11 of a FIT file header are ".FIT"; that's all the importer needs to pass it along.
const fakeFit = new Uint8Array([14, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0])

async function zipOf(entries: Record<string, string | Uint8Array | Blob>): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'))
  for (const [name, content] of Object.entries(entries)) {
    const reader =
      typeof content === 'string'
        ? new TextReader(content)
        : content instanceof Blob
          ? new Uint8ArrayReader(new Uint8Array(await content.arrayBuffer()))
          : new Uint8ArrayReader(content)
    await writer.add(name, reader)
  }
  return writer.close()
}

describe('extractActivityFiles', () => {
  it('pulls activities.csv and FIT files out of a Strava archive', async () => {
    const zip = await zipOf({
      'activities.csv': 'Activity ID,Activity Date,Activity Name,Activity Type\n1,"Mar 1, 2026",Run,Run\n',
      'comments.csv': 'Activity ID,Comment\n1,nice\n',
      'profile.csv': 'Athlete ID,Email\n1,me@example.com\n',
      'activities/111.fit.gz': new Uint8Array([0x1f, 0x8b, 1, 2]),
      'activities/222.gpx': '<gpx/>',
      'media/photo.jpg': new Uint8Array([0xff, 0xd8]),
    })
    const result = await extractActivityFiles(zip)
    expect(result.files.map((f) => f.name).sort()).toEqual(['111.fit.gz', 'activities.csv'])
    expect(result.unsupportedActivityFiles).toBe(1)
  })

  it('reads FIT files inside the nested ZIPs of a Garmin export', async () => {
    const inner = await zipOf({ 'me@example.com_24838623807.fit': fakeFit })
    const zip = await zipOf({
      'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip': inner,
      'DI_CONNECT/DI-Connect-Wellness/sleep.json': '{}',
    })
    const result = await extractActivityFiles(zip)
    expect(result.files.map((f) => f.name)).toEqual(['24838623807.fit'])
    expect(new Uint8Array(await result.files[0].arrayBuffer())).toEqual(fakeFit)
  })
})

describe('helpers', () => {
  it('recognizes Garmin and Strava activity CSV headers only', () => {
    expect(isActivityCsvHeader('\uFEFF"Activity Type","Date","Favorite"\n')).toBe(true)
    expect(isActivityCsvHeader('Activity ID,Activity Date,Activity Name,Activity Type\n')).toBe(true)
    expect(isActivityCsvHeader('Activity ID,Comment\n')).toBe(false)
  })

  it('strips the Garmin account email from file names', () => {
    expect(uploadName('a/b/me@example.com_123.fit')).toBe('123.fit')
    expect(uploadName('activities/456.fit.gz')).toBe('456.fit.gz')
  })
})
