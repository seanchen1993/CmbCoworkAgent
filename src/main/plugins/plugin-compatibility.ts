import type { PluginMetadata } from "../types"
import type { PluginCompatibilityReport } from "../../shared/plugin-compatibility"
import { readNativeCapabilityCatalog, type NativeCapabilityCatalog } from "./capability-catalog"
import { readProjectCompositionCatalog } from "./project-composition-catalog"

/** Reuses the execution catalog's static validators. No retained source, grant or runtime token. */
export async function readPluginCompatibility(
  plugin: PluginMetadata,
  readCatalog: typeof readNativeCapabilityCatalog = readNativeCapabilityCatalog
): Promise<PluginCompatibilityReport> {
  const observed: { catalog?: NativeCapabilityCatalog } = {}
  const result = await readProjectCompositionCatalog([plugin], undefined, async (...args) => {
    const catalog = await readCatalog(...args)
    observed.catalog = catalog
    return catalog
  })
  const catalog = observed.catalog
  if (!catalog) throw Error("PLUGIN_COMPATIBILITY_UNCONFIRMED")
  return {
    source: {
      pluginId: plugin.id,
      name: plugin.name,
      version: plugin.version,
      enabled: plugin.enabled,
      packageDigest: catalog.packageDigest
    },
    checkedAt: Date.now(),
    status: catalog.status,
    authorization: "not-evaluated",
    chat: "check-in-chat",
    reasons: [...catalog.reasons],
    entries: result.sources.map(({ capability, entry }) => {
      const mode = catalog.capabilities.find((item) => item.id === capability.id)?.runtimeMode
      return {
        id: capability.id,
        title: entry.title,
        kind: entry.kind,
        ...(mode ? { runtimeMode: mode } : {}),
        available: entry.available,
        reasons: [...entry.reasons]
      }
    })
  }
}
