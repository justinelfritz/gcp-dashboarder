import { describe, expect, it } from 'vitest'
import type { ActivityType } from '../api/client'
import { isSelected, retitleForTypes, setSelected, starterDashboard, toDisplayFilters, upgradeStarterColors } from './model'
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

describe('retitleForTypes', () => {
  const panels = starterDashboard().panels
  const speed = (types: ActivityType[]) => retitleForTypes(panels, types).find((p) => p.title.startsWith('Speed'))?.title

  it('names the sport when only one is selected', () => {
    expect(speed(['run'])).toBe('Speed: 5k vs 10k runs')
    expect(speed(['ride'])).toBe('Speed: 5k vs 10k rides')
    expect(speed(['hike'])).toBe('Speed: 5k vs 10k hikes')
  })

  it('says activities when several sports are selected', () => {
    expect(speed(['run', 'ride'])).toBe('Speed: 5k vs 10k activities')
  })

  it('leaves edited titles alone', () => {
    const edited = panels.map((p) => ({ ...p, title: p.title === 'Speed: 5k vs 10k runs' ? 'My speeds' : p.title }))
    expect(retitleForTypes(edited, ['ride']).map((p) => p.title)).toEqual(edited.map((p) => p.title))
  })
})

it('gives each starter panel its own colors', () => {
  const slots = starterDashboard().panels.flatMap((p) => p.series.map((s) => s.color_slot))
  expect(new Set(slots).size).toBe(slots.length)
})

describe('upgradeStarterColors', () => {
  const fresh = starterDashboard()
  // A starter dashboard saved before the panels had their own colors.
  const old = {
    ...fresh,
    panels: fresh.panels.map((p) => ({ ...p, series: p.series.map((s, i) => ({ ...s, color_slot: i })) })),
  }

  it('recolors untouched starter panels', () => {
    expect(upgradeStarterColors(old).panels.map((p) => p.series)).toEqual(fresh.panels.map((p) => p.series))
  })

  it('keeps panels the user recolored or renamed', () => {
    const custom = {
      ...old,
      panels: old.panels.map((p, i) =>
        i === 0 ? { ...p, series: [{ ...p.series[0], color_slot: 3 }] } : i === 1 ? { ...p, title: 'Mine' } : p),
    }
    const out = upgradeStarterColors(custom).panels
    expect(out[0].series[0].color_slot).toBe(3)
    expect(out[1].series.map((s) => s.color_slot)).toEqual([0, 1])
    expect(out[2].series[0].color_slot).toBe(6)
  })

  it('returns current dashboards unchanged', () => {
    expect(upgradeStarterColors(fresh)).toBe(fresh)
  })
})
