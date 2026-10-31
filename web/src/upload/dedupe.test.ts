// @vitest-environment node
// Node has the real File (with arrayBuffer) and Web Crypto; jsdom's File lacks arrayBuffer.
import { describe, expect, it, vi } from 'vitest'
import { sha256Hex, skipStoredFiles } from './dedupe'

const file = (name: string, text: string) => new File([text], name)

describe('skipStoredFiles', () => {
  it('hashes FIT files with SHA-256', async () => {
    // sha256("abc")
    expect(await sha256Hex(file('a.fit', 'abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('drops FIT files the API already has, and same-content repeats, but keeps every CSV', async () => {
    const old = file('old.fit', 'old run')
    const repeat = file('nested/old-copy.fit', 'old run')
    const fresh = file('new.fit.gz', 'new run')
    const twin = file('new-again.fit.gz', 'new run')
    const csv = file('activities.csv', 'Activity Type,Date')
    const oldHash = await sha256Hex(old)
    const check = vi.fn(async (_sid: string, hashes: string[]) => ({ known: hashes.filter((h) => h === oldHash) }))

    const result = await skipStoredFiles('s', [old, repeat, fresh, twin, csv], undefined, check)

    expect(result.files).toEqual([fresh, csv])
    expect(result.alreadyStored).toBe(2)
    // Each distinct file is checked once; CSVs aren't checked.
    expect(check).toHaveBeenCalledTimes(1)
    expect(check.mock.calls[0][1]).toHaveLength(2)
  })

  it('uploads everything when the check fails', async () => {
    const files = [file('a.fit', 'a'), file('b.fit', 'b')]
    const result = await skipStoredFiles('s', files, undefined, async () => { throw new Error('offline') })
    expect(result).toEqual({ files, alreadyStored: 0 })
  })

  it('skips the check when there are no FIT files', async () => {
    const check = vi.fn()
    const csv = [file('activities.csv', 'x')]
    expect(await skipStoredFiles('s', csv, undefined, check)).toEqual({ files: csv, alreadyStored: 0 })
    expect(check).not.toHaveBeenCalled()
  })
})
