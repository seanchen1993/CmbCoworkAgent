import { useEffect, useSyncExternalStore } from "react"
import type { MarketSkillShortcutBinding } from "../../../shared/market-skill-shortcut"
import { useAppStore } from "./store"

const REFRESH_MS = 60_000
const listeners = new Set<() => void>()
let cache: {
  accountRevision: number
  binding: MarketSkillShortcutBinding | null
  expires: number
} | null = null
let pending: { accountRevision: number; promise: Promise<void> } | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function publish(accountRevision: number, binding: MarketSkillShortcutBinding | null): void {
  cache = { accountRevision, binding, expires: Date.now() + REFRESH_MS }
  for (const listener of listeners) listener()
}

export function refreshMarketSkillShortcut(accountRevision: number, force = false): Promise<void> {
  if (
    !window.api?.marketSkillShortcut ||
    useAppStore.getState().accountRevision !== accountRevision
  ) {
    return Promise.resolve()
  }
  if (pending?.accountRevision === accountRevision) return pending.promise
  if (!force && cache?.accountRevision === accountRevision && cache.expires > Date.now()) {
    return Promise.resolve()
  }

  const promise = window.api.marketSkillShortcut
    .get()
    .then(
      (result) => (result.ok ? result.value : null),
      () => null
    )
    .then((binding) => {
      if (
        pending?.promise === promise &&
        useAppStore.getState().accountRevision === accountRevision
      ) {
        publish(accountRevision, binding)
      }
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null
    })
  pending = { accountRevision, promise }
  return promise
}

export function useMarketSkillShortcut() {
  const accountRevision = useAppStore((state) => state.accountRevision)
  const binding = useSyncExternalStore(
    subscribe,
    () => (cache?.accountRevision === accountRevision ? cache.binding : null),
    () => null
  )
  useEffect(() => {
    const refresh = () => void refreshMarketSkillShortcut(accountRevision)
    const refreshOnFocus = () => void refreshMarketSkillShortcut(accountRevision, true)
    refresh()
    const interval = window.setInterval(refreshOnFocus, REFRESH_MS)
    window.addEventListener("focus", refreshOnFocus)
    window.addEventListener("online", refreshOnFocus)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshOnFocus)
      window.removeEventListener("online", refreshOnFocus)
    }
  }, [accountRevision])
  return { accountRevision, binding }
}
