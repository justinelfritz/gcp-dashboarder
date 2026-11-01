import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { starterDashboard, toQueryRequest } from './model'
import { DashboardImportError, exportDashboard, forgetOwner, fromAccountDocument, parseDashboard, toAccountDocument, useDashboards } from './store'
import { DEFAULT_SETTINGS } from './types'

describe('dashboard import/export', () => {
  it('round-trips a dashboard, with fresh IDs', () => {
    const d = starterDashboard()
    const back = parseDashboard(exportDashboard(d))
    expect(back.name).toBe(d.name)
    expect(back.panels.map((p) => p.title)).toEqual(d.panels.map((p) => p.title))
    expect(back.panels[1].series).toEqual(d.panels[1].series)
    expect(back.id).not.toBe(d.id)
  })

  it('round-trips an activity selection and validates it', () => {
    const d = starterDashboard()
    d.filters.selection = { mode: 'only', ids: ['a1', 'a2'] }
    expect(parseDashboard(exportDashboard(d)).filters.selection).toEqual({ mode: 'only', ids: ['a1', 'a2'] })
    expect(parseDashboard(exportDashboard(starterDashboard())).filters).not.toHaveProperty('selection')
    const bad = JSON.stringify({ schema_version: 1, filters: { selection: { mode: 'some' } }, panels: [] })
    expect(() => parseDashboard(bad)).toThrow(/selection mode/)
  })

  it('round-trips subtype choices, dropping unknown sports and subtypes', () => {
    const d = starterDashboard()
    d.filters.activity_subtypes = { run: ['trail'] }
    d.panels[0] = { ...d.panels[0], series: [{ label: 'Trail', color_slot: 0, activity_subtype: 'trail' }] }
    const back = parseDashboard(exportDashboard(d))
    expect(back.filters.activity_subtypes).toEqual({ run: ['trail'] })
    expect(back.panels[0].series[0].activity_subtype).toBe('trail')
    const odd = JSON.stringify({ ...JSON.parse(exportDashboard(d)), filters: {
      activity_types: ['run'], activity_subtypes: { run: ['trail', 'moon', 'trail'], swim: ['pool'] } } })
    expect(parseDashboard(odd).filters.activity_subtypes).toEqual({ run: ['trail'] })
    expect(parseDashboard(exportDashboard(starterDashboard())).filters).not.toHaveProperty('activity_subtypes')
  })

  it('round-trips a right-axis quantity, and loads panels without one', () => {
    const d = starterDashboard()
    d.panels[0] = { ...d.panels[0], y2: { field: 'avg_hr', level: 'activity', agg: 'mean' } }
    const back = parseDashboard(exportDashboard(d))
    expect(back.panels[0].y2).toEqual({ field: 'avg_hr', level: 'activity', agg: 'mean' })
    expect(back.panels[1]).not.toHaveProperty('y2')
    const styled = starterDashboard()
    styled.panels[1] = { ...styled.panels[1], y2_line: 'dot', series: [{ ...styled.panels[1].series[0], y2_color_slot: 5 }] }
    const again = parseDashboard(exportDashboard(styled)).panels[1]
    expect(again.y2_line).toBe('dot')
    expect(again).not.toHaveProperty('trend')
    styled.panels[1] = { ...styled.panels[1], trend: true, y2_trend: true }
    expect(parseDashboard(exportDashboard(styled)).panels[1]).toMatchObject({ trend: true, y2_trend: true })
    expect(again.series[0].y2_color_slot).toBe(5)
    const badLine = JSON.stringify({ schema_version: 1, panels: [{ y: { field: 'distance_m' }, y2_line: 'wavy' }] })
    expect(() => parseDashboard(badLine)).toThrow(/right axis line/)
    const bad = JSON.stringify({ schema_version: 1, panels: [{ y: { field: 'distance_m' }, y2: { level: 'lap' } }] })
    expect(() => parseDashboard(bad)).toThrow(/right axis/)
  })

  it('rejects bad input with a reason', () => {
    expect(() => parseDashboard('nope')).toThrow(DashboardImportError)
    expect(() => parseDashboard('{"schema_version": 2, "panels": []}')).toThrow(/schema_version/)
    const badChart = JSON.stringify({ schema_version: 1, panels: [{ chart: 'pie', y: { field: 'distance_m' } }] })
    expect(() => parseDashboard(badChart)).toThrow(/chart/)
    const noY = JSON.stringify({ schema_version: 1, panels: [{}] })
    expect(() => parseDashboard(noY)).toThrow(/y axis/)
  })

  it('clamps out-of-range values instead of trusting them', () => {
    const d = parseDashboard(JSON.stringify({
      schema_version: 1,
      filters: { activity_types: ['run', 'swim'] },
      panels: [{ y: { field: 'distance_m' }, series: [{ color_slot: 11 }], layout: { w: 99, h: -4 } }],
    }))
    expect(d.filters.activity_types).toEqual(['run'])
    expect(d.panels[0].series[0].color_slot).toBe(3)
    expect(d.panels[0].layout).toMatchObject({ w: 12, h: 3 })
  })
})

describe('toQueryRequest', () => {
  it('adds a companion query only for panels with a right-axis quantity', () => {
    const d = starterDashboard()
    d.panels[0] = { ...d.panels[0], y2: { field: 'avg_hr', level: 'activity', agg: 'mean' } }
    const req = toQueryRequest(d, DEFAULT_SETTINGS)
    expect(req.panels.map((p) => p.id)).toEqual([d.panels[0].id, `${d.panels[0].id}~y2`, ...d.panels.slice(1).map((p) => p.id)])
    const [main, companion] = req.panels
    expect(companion).toEqual({ ...main, id: companion.id, y: { field: 'avg_hr', level: 'activity', agg: 'mean' } })
  })

  it('turns series distances into ± tolerance filters and presets into date ranges', () => {
    const req = toQueryRequest(starterDashboard(), { ...DEFAULT_SETTINGS, distance_tolerance: 0.03 })
    expect(req.distance_tolerance).toBe(0.03)
    expect(req.filters?.date_range).toEqual({ last_days: 90 })
    const custom = { ...starterDashboard() }
    custom.panels = [{ ...custom.panels[0], series: [{ label: 'Rides', color_slot: 2, activity_type: 'ride' }] }]
    expect(toQueryRequest(custom, DEFAULT_SETTINGS).panels[0].series).toEqual([
      { label: 'Rides', filters: [{ field: 'activity_type', op: 'eq', value: 'ride' }] },
    ])
    expect(req.panels[1].series).toEqual([
      { label: '5k', filters: [{ field: 'distance_m', op: 'near', value: 5000 }] },
      { label: '10k', filters: [{ field: 'distance_m', op: 'near', value: 10000 }] },
    ])
  })
})

describe('account documents', () => {
  it('round-trip with IDs kept, dropping only the unreadable dashboard', () => {
    const d = starterDashboard()
    const doc = toAccountDocument({ activeId: d.id, dashboards: [d] }, { units: 'metric', distance_tolerance: 0.03 })
    const broken = { ...doc, dashboards: [...doc.dashboards, { schema_version: 1, panels: [{ chart: 'pie' }] }] }
    const back = fromAccountDocument(JSON.parse(JSON.stringify(broken)))!
    expect(back.saved.activeId).toBe(d.id)
    expect(back.saved.dashboards).toHaveLength(1)
    expect(back.saved.dashboards[0].panels.map((p) => p.id)).toEqual(d.panels.map((p) => p.id))
    expect(back.settings).toEqual({ units: 'metric', distance_tolerance: 0.03 })
  })

  it('rejects documents with nothing usable, and clamps settings', () => {
    expect(fromAccountDocument(null)).toBeNull()
    expect(fromAccountDocument({ schema_version: 2, dashboards: [] })).toBeNull()
    const d = starterDashboard()
    const odd = fromAccountDocument({ schema_version: 1, activeId: 'gone', dashboards: [d], settings: { units: 'furlongs', distance_tolerance: 9 } })!
    expect(odd.saved.activeId).toBe(d.id)
    expect(odd.settings).toEqual({ units: 'imperial', distance_tolerance: 0.5 })
  })
})

describe('per-owner caches', () => {
  afterEach(() => localStorage.clear())

  it('keeps guest and account dashboards apart, seeding an account from the guest once', () => {
    const { result, rerender } = renderHook(({ owner }) => useDashboards(owner), { initialProps: { owner: null as string | null } })
    act(() => result.current.update({ ...result.current.active, name: 'Guest board' }))
    rerender({ owner: 'alice' })
    expect(result.current.active.name).toBe('Guest board') // first sign-in starts from the guest's
    act(() => result.current.update({ ...result.current.active, name: 'Alice board' }))
    rerender({ owner: null })
    expect(result.current.active.name).toBe('Guest board') // signing out doesn't show Alice's
    rerender({ owner: 'alice' })
    expect(result.current.active.name).toBe('Alice board')
    forgetOwner('alice')
    expect(localStorage.getItem('dashboarder.dashboards:alice')).toBeNull()
  })
})
