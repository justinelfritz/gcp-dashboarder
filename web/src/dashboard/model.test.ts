import { describe, expect, it } from 'vitest'
import type { ActivityType } from '../api/client'
import { dateWindow, isSelected, retitleForTypes, setSelected, splitBySubtype, starterDashboard, subtypeCounts, toDisplayFilters, toPanelQuery, upgradeStarterColors } from './model'
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

describe('dateWindow', () => {
  const now = new Date(Date.UTC(2026, 9, 30, 15, 0)) // Oct 30 2026 15:00 UTC
  const wallNow = now.getTime() - now.getTimezoneOffset() * 60_000

  it('covers the last N days up to now, in local wall-clock time', () => {
    expect(dateWindow({ ...base, date_preset: 'last_30' }, now)).toEqual({ start: wallNow - 30 * 86_400_000, end: wallNow })
  })

  it('covers whole days of a custom range, and nothing for all time', () => {
    expect(dateWindow({ ...base, date_preset: 'custom', start: '2026-09-01', end: '2026-09-30' }, now)).toEqual({
      start: Date.parse('2026-09-01T00:00:00Z'), end: Date.parse('2026-10-01T00:00:00Z'),
    })
    expect(dateWindow({ ...base, date_preset: 'custom', start: '2026-09-01' }, now)).toEqual({
      start: Date.parse('2026-09-01T00:00:00Z'), end: undefined,
    })
    expect(dateWindow({ ...base, date_preset: 'custom' }, now)).toBeUndefined()
    expect(dateWindow({ ...base, date_preset: 'all' }, now)).toBeUndefined()
  })
})

describe('subtypes', () => {
  it('sends subtype choices only for selected sports', () => {
    const f: DashboardFilters = { ...base, activity_types: ['run'], activity_subtypes: { run: ['trail'], ride: ['gravel'] } }
    expect(toDisplayFilters(f).activity_subtypes).toEqual({ run: ['trail'] })
    expect(toDisplayFilters({ ...f, activity_subtypes: { run: [] } }).activity_subtypes).toBeUndefined()
  })

  it('turns a series subtype into a filter', () => {
    const p = { ...starterDashboard().panels[0], series: [{ label: 'Trail', color_slot: 0, activity_subtype: 'trail' as const }] }
    expect(toPanelQuery(p).series?.[0].filters).toEqual([{ field: 'activity_subtype', op: 'eq', value: 'trail' }])
  })

  it('splits into one series per subtype, most common first, keeping sport and distance', () => {
    const catalog = { total_activities: 9, levels: { activity: [], lap: [], record: [] },
      subtypes: { run: { standard: 2, trail: 5 }, ride: { gravel: 2 } } }
    expect(subtypeCounts(catalog)).toEqual({ standard: 2, trail: 5, gravel: 2 })
    const counts = subtypeCounts(catalog, 'run')
    expect(splitBySubtype([{ label: '5k', color_slot: 3, distance_m: 5000, activity_type: 'run' }], counts)).toEqual([
      { label: 'Trail', color_slot: 0, activity_subtype: 'trail', distance_m: 5000, activity_type: 'run' },
      { label: 'Standard', color_slot: 1, activity_subtype: 'standard', distance_m: 5000, activity_type: 'run' },
    ])
    expect(splitBySubtype([{ label: 'All', color_slot: 0 }], { trail: 4 })).toBeUndefined()
  })
})
