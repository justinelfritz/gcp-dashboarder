import { describe, expect, it, vi } from 'vitest'
import type { FileReport, UploadResponse } from '../api/client'
import { makeBatches, uploadInBatches } from './batchUpload'

const file = (name: string, size: number) => new File([new Uint8Array(size)], name)

const report = (f: File): FileReport => ({
  filename: f.name,
  detected_format: 'fit',
  size_bytes: f.size,
  activities_parsed: 1,
  activities_added: 1,
  duplicates_merged: 0,
  rows_rejected: 0,
  rejections: [],
  warnings: [],
})

describe('makeBatches', () => {
  it('splits on byte and file-count limits, preserving order', () => {
    const files = [file('a', 6), file('b', 6), file('c', 1), file('d', 1), file('e', 1)]
    const batches = makeBatches(files, { maxBytes: 10, maxFiles: 2 })
    expect(batches.map((b) => b.map((f) => f.name))).toEqual([['a'], ['b', 'c'], ['d', 'e']])
  })

  it('puts an oversized file in a batch of its own', () => {
    const batches = makeBatches([file('big', 50), file('small', 1)], { maxBytes: 10, maxFiles: 5 })
    expect(batches.map((b) => b.length)).toEqual([1, 1])
  })
})

describe('uploadInBatches', () => {
  it('collects reports, reports failed batches, and keeps going', async () => {
    let call = 0
    const upload = vi.fn(async (_sid: string, files: File[]): Promise<UploadResponse> => {
      call++
      if (call === 2) throw new Error('POST failed: 503')
      return { upload_id: `u${call}`, files: files.map(report), total_activities: call * 10 }
    })
    const progress = vi.fn()
    const files = ['a', 'b', 'c', 'd', 'e'].map((n) => file(n, 1))
    const result = await uploadInBatches('sid', files, {}, progress, upload, {
      maxBytes: 100,
      maxFiles: 2,
    })
    expect(upload).toHaveBeenCalledTimes(3)
    expect(result.reports.map((r) => r.filename)).toEqual(['a', 'b', 'e'])
    expect(result.failedFiles).toEqual([
      { name: 'c', error: 'POST failed: 503' },
      { name: 'd', error: 'POST failed: 503' },
    ])
    expect(result.totalActivities).toBe(30)
    expect(progress).toHaveBeenLastCalledWith({ uploadedFiles: 5, totalFiles: 5 })
  })
})
