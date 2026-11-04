import { useCallback, useEffect, useState } from "react"
import type { ManagedRunSchedule } from "../../../shared/managed-run-schedule"

export function useManagedRunSchedule(projectId?: string, featureId?: string, refreshRevision = 0) {
  const [retryRevision, setRetryRevision] = useState(0)
  const reload = useCallback(() => setRetryRevision((revision) => revision + 1), [])
  const key = JSON.stringify([projectId, featureId])
  const [state, setState] = useState<{
    key: string
    schedule: ManagedRunSchedule | null
    error?: string
  }>({ key: "", schedule: null })
  useEffect(() => {
    if (!projectId || !featureId) return
    let active = true
    let changed = false
    const unsubscribe = window.api.harnessBoard.onManagedRunScheduleChanged((event) => {
      if (event.projectId !== projectId || event.featureId !== featureId) return
      changed = true
      setState({ key, schedule: event.schedule })
    })
    void window.api.harnessBoard
      .getManagedRunSchedule(projectId, featureId)
      .then((schedule) => {
        if (active && !changed) setState({ key, schedule })
      })
      .catch((error) => {
        if (active && !changed) setState({ key, schedule: null, error: String(error) })
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [key, projectId, featureId, refreshRevision, retryRevision])
  return {
    schedule: state.key === key ? state.schedule : null,
    loading: Boolean(projectId && featureId && state.key !== key),
    error: state.key === key ? state.error : undefined,
    reload
  }
}

export function useManagedRunScheduleIndex(refreshRevision = 0): Map<string, string> {
  const [schedules, setSchedules] = useState(() => new Map<string, string>())
  useEffect(() => {
    let active = true
    const changes = new Map<string, string | null>()
    let loading = true
    const unsubscribe = window.api.harnessBoard.onManagedRunScheduleChanged((event) => {
      const key = JSON.stringify([event.projectId, event.featureId])
      const time =
        event.schedule?.status === "pending" || event.schedule?.status === "starting"
          ? event.schedule.scheduledAt
          : null
      if (loading) changes.set(key, time)
      setSchedules((current) => {
        const next = new Map(current)
        if (time) next.set(key, time)
        else next.delete(key)
        return next
      })
    })
    void window.api.harnessBoard
      .getActiveManagedRunSchedules()
      .then((rows) => {
        if (!active) return
        const next = new Map(
          rows.map((row) => [JSON.stringify([row.projectId, row.featureId]), row.scheduledAt])
        )
        // Apply events received during the initial query so stale query results cannot restore a cancelled reservation.
        for (const [key, time] of changes) {
          if (time) next.set(key, time)
          else next.delete(key)
        }
        changes.clear()
        loading = false
        setSchedules(next)
      })
      .catch((error) => {
        loading = false
        changes.clear()
        console.warn("[ManagedRun] Failed to read sidebar reservations:", error)
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [refreshRevision])
  return schedules
}
