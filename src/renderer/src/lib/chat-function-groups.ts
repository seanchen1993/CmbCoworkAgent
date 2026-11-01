import type { PluginMetadata } from "@/types"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"
import { groupInstalledPlugins } from "./installed-plugin-groups"

/** Presentation of eligible sources only; never changes selection, grants or runtime discovery. */
export function chatFunctionGroups(
  sources: readonly FunctionPluginStatus[],
  installed: readonly PluginMetadata[]
) {
  const { owners, roots } = groupInstalledPlugins(installed)
  const independent = new Set(roots.map((plugin) => plugin.id))
  return {
    available: sources.filter(
      (source) => !owners.has(source.pluginId) || independent.has(source.pluginId)
    ),
    dependencies: sources.flatMap((source) => {
      const projects = owners.get(source.pluginId)
      return projects?.length && !independent.has(source.pluginId) ? [{ source, projects }] : []
    })
  }
}
