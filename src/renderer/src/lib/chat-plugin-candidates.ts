import type { PluginMetadata } from "@/types"
import { groupInstalledPlugins } from "./installed-plugin-groups"
import { hasUsableClawComponents } from "./claw-capability-usage"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

/** Catalog hints only; prepareStartUse must still validate the actual installed kind. */
export function chatPluginCandidates(
  plugins: readonly PluginMetadata[],
  sources: readonly FunctionPluginStatus[] = []
) {
  const unavailable = new Set(
    sources
      .filter((source) => !hasUsableClawComponents(source, "chat"))
      .map((source) => source.pluginId)
  )
  return groupInstalledPlugins(plugins).roots.filter(
    (plugin) =>
      !plugin.hasProjectMode &&
      plugin.projectDependencyIds === undefined &&
      !plugin.dependencyOnly &&
      !unavailable.has(plugin.id)
  )
}
