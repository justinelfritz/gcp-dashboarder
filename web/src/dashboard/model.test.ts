import { describe, expect, it } from 'vitest'
import { isSelected, setSelected, toDisplayFilters } from './model'
import type { DashboardFilters } from './types'

const base: DashboardFilters = { activity_types: ['run'], date_preset: 'all' }

describe('activity selection', () => {
  it('includes everything when nothing is picked', () => {
    expect(isSelected(undefined, 'a')).toBe(true)
    expect(toDisplayFilters(base)).toEqual({ activity_types: ['run'], date_range: undefined })
  })

  it('"all" mode lists the unchecked activities and sends them as exclusions', () => {
    const sel = setSelected(undefined, ['a', 'b'], false)
    expect(sel).toEqual({ mode: 'all', ids: ['a', 'b'] })
    expect(isSelected(sel, 'a')).toBe(false)
    expect(isSelected(sel, 'new')).toBe(true)
    const back = setSelected(sel, ['a'], true)
    expect(back.ids).toEqual(['b'])
    expect(toDisplayFilters({ ...base, selection: back }).exclude_activity_ids).toEqual(['b'])
  })

  it('"only" mode lists the checked activities and sends them as the whole set', () => {
    const sel = setSelected({ mode: 'only', ids: [] }, ['a', 'a', 'c'], true)
    expect(sel).toEqual({ mode: 'only', ids: ['a', 'c'] })
    expect(isSelected(sel, 'new')).toBe(false)
    expect(toDisplayFilters({ ...base, selection: sel }).activity_ids).toEqual(['a', 'c'])
    // Picking nothing analyzes nothing, rather than falling back to everything.
    expect(toDisplayFilters({ ...base, selection: { mode: 'only', ids: [] } }).activity_ids).toEqual([])
  })
})
