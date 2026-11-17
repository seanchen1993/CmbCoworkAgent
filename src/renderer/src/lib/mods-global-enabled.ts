import { useEffect, useState } from "react"

let pending: Promise<boolean> | undefined

export function invalidateModsGlobalEnabled(): void {
  pending = undefined
}

/** Coalesce existing chat surfaces' concurrent switch reads without caching stale settings. */
export function readModsGlobalEnabled(): Promise<boolean> {
  if (!pending) {
    const current = window.api.mods.globalEnabled()
    pending = current
    void current
      .finally(() => {
        if (pending === current) pending = undefined
      })
      .catch(() => {})
  }
  return pending
}

/** Keep one application-level switch observer for passive chat extensions. */
export function observeModsGlobalEnabled(onEnabled: (enabled: boolean) => void): () => void {
  const mods = window.api?.mods
  if (typeof mods?.globalEnabled !== "function") return () => {}
  let revision = 0
  let live = true
  const refresh = () => {
    const ticket = ++revision
    const commit = (enabled: boolean) => {
      if (live && ticket === revision) onEnabled(enabled === true)
    }
    void Promise.resolve().then(() => live && ticket === revision ? readModsGlobalEnabled() : false)
      .then(commit, () => commit(false))
  }
  const changed = () => {
    invalidateModsGlobalEnabled()
    refresh()
  }
  const stop = mods.onConfigurationChanged?.((event) => {
    if (event?.scope !== "schema") changed()
  })
  window.addEventListener("mods:configuration-changed", changed)
  refresh()
  return () => {
    live = false
    stop?.()
    window.removeEventListener("mods:configuration-changed", changed)
  }
}

export function useModsGlobalEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => observeModsGlobalEnabled(setEnabled), [])
  return enabled
}
