import { useEffect, useState, useSyncExternalStore } from "react"
import type { PluginMetadata } from "@/types"
import { useAppStore } from "./store"
import {
  getPluginCatalogRevision,
  revalidatePluginCatalog,
  subscribePluginCatalogInvalidation
} from "./app-catalog-cache"

/** Reuses the paged application catalog; no extra full-directory read or runtime mutation. */
export function useChatPluginAttribution(active: boolean): readonly PluginMetadata[] {
  const account = useAppStore((state) => state.accountRevision)
  const version = useAppStore((state) => state.pluginVersion) ?? 0
  const revision = useSyncExternalStore(subscribePluginCatalogInvalidation, () =>
    getPluginCatalogRevision(version)
  )
  const scope = JSON.stringify([account, revision])
  const [value, setValue] = useState<{ scope: string; plugins: PluginMetadata[] }>()
  useEffect(() => {
    if (!active) return
    let current = true
    void revalidatePluginCatalog(version)
      .then((snapshot) => {
        if (current && getPluginCatalogRevision(version) === revision)
          setValue({ scope, plugins: snapshot.plugins })
      })
      .catch(() => {
        if (current) setValue({ scope, plugins: [] })
      })
    return () => {
      current = false
    }
  }, [active, version, revision, scope])
  return value?.scope === scope ? value.plugins : []
}
