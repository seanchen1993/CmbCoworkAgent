import { useSyncExternalStore } from "react"
import type { AppNotification } from "../../../shared/app-notifications"

let snapshot: AppNotification[] = []
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let generation = 0
let refreshInFlight: Promise<void> | undefined
let refreshRequested = false
let retryTimer: ReturnType<typeof setTimeout> | undefined

function retryRefresh(): void {
  if (retryTimer || listeners.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void refreshAppNotifications()
  }, 2000)
}
const onFocus = (): void => { void refreshAppNotifications() }

export function refreshAppNotifications(): Promise<void> {
  refreshRequested = true
  generation += 1
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = Promise.resolve().then(async () => {
    while (refreshRequested) {
      refreshRequested = false
      const current = generation
      try {
        const values = await window.api.appNotifications.list()
        if (current !== generation) continue
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = undefined
        snapshot = values
        for (const listener of listeners) listener()
      } catch (error) {
        console.error("[Notifications] Failed to load notifications:", error)
        if (current === generation) retryRefresh()
      }
    }
  }).finally(() => {
    refreshInFlight = undefined
    if (refreshRequested) return refreshAppNotifications()
    return undefined
  })
  return refreshInFlight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!unsubscribe) {
    unsubscribe = window.api.appNotifications.onChanged(() => void refreshAppNotifications())
    window.addEventListener("focus", onFocus)
    void refreshAppNotifications()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribe?.()
      unsubscribe = undefined
      generation += 1
      refreshRequested = false
      window.removeEventListener("focus", onFocus)
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }
}

export function useAppNotifications(): AppNotification[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}
