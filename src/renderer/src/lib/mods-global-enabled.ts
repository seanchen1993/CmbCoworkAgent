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
