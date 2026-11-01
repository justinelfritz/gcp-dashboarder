import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import type { ActivityListParams, ActivitySummary, ActivityType, FieldCatalog, PanelResult, QueryRequest } from '../api/client'
import { activeSubtypes, toDateRange, toQueryRequest } from './model'
import type { Dashboard, DashboardFilters, Settings } from './types'

const QUERY_DEBOUNCE_MS = 300
const MAX_ACTIVITIES = 5000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Results for every panel, fetched in one request. Layout, titles, and chart type don't affect
 * the query, so dragging or renaming a panel doesn't refetch. While loading, the previous
 * results stay on screen.
 */
export function usePanelResults(scope: string, dashboard: Dashboard, settings: Settings, refreshKey: number) {
  const [results, setResults] = useState<Map<string, PanelResult>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestKey = JSON.stringify(toQueryRequest(dashboard, settings))

  useEffect(() => {
    const request = JSON.parse(requestKey) as QueryRequest
    if (!request.panels.length) {
      setResults(new Map())
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .query(scope, request)
        .then((resp) => {
          if (cancelled) return
          setResults(new Map(resp.panels.map((p) => [p.id, p])))
          setError(null)
        })
        .catch((err) => !cancelled && setError(message(err)))
        .finally(() => !cancelled && setLoading(false))
    }, QUERY_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scope, requestKey, refreshKey])

  return { results, loading, error }
}

export function useFieldCatalog(scope: string, activityTypes: ActivityType[], refreshKey: number) {
  const [catalog, setCatalog] = useState<FieldCatalog | null>(null)
  const typesKey = [...activityTypes].sort().join(',')
  useEffect(() => {
    let cancelled = false
    api
      .fields(scope, typesKey ? (typesKey.split(',') as ActivityType[]) : [])
      .then((c) => !cancelled && setCatalog(c))
      .catch(() => !cancelled && setCatalog(null))
    return () => {
      cancelled = true
    }
  }, [scope, typesKey, refreshKey])
  return catalog
}

/**
 * Every activity matching the dashboard's sport, subtype, and date filters (ignoring the
 * hand-picked selection, which is chosen from this list), newest first.
 */
export function useActivities(scope: string, filters: DashboardFilters, refreshKey: number) {
  const [items, setItems] = useState<ActivitySummary[]>([])
  const [loaded, setLoaded] = useState(false)
  const range = toDateRange(filters)
  const paramsKey = JSON.stringify({
    activity_type: [...filters.activity_types].sort(),
    last_days: range?.last_days,
    start: range?.start,
    end: range?.end,
  })
  useEffect(() => {
    let cancelled = false
    api
      .activities(scope, { ...(JSON.parse(paramsKey) as ActivityListParams), limit: MAX_ACTIVITIES })
      .then((list) => {
        if (cancelled) return
        setItems(list.items)
        setLoaded(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [scope, paramsKey, refreshKey])
  // Subtypes narrow the list here rather than in the request, so changing them needs no refetch.
  const subtypesKey = JSON.stringify(activeSubtypes(filters))
  const shown = useMemo(() => {
    const subtypes = JSON.parse(subtypesKey) as ReturnType<typeof activeSubtypes>
    return items.filter((a) => subtypes[a.activity_type]?.includes(a.activity_subtype) ?? true)
  }, [items, subtypesKey])
  return { items: shown, loaded }
}

export function activityLabel(a: ActivitySummary): string {
  return a.name || `${a.activity_type} ${new Date(a.start_time).toLocaleDateString()}`
}
