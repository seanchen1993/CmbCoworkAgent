import type { PluginMetadata } from "@/types"

/** Display grouping only. Runtime authority and installed identities are never changed. */
export function groupInstalledPlugins(plugins: readonly PluginMetadata[]) {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const dependencies = new Map<string, PluginMetadata[]>()
  const owners = new Map<string, string[]>()
  for (const plugin of plugins) {
    const children = [...new Set(plugin.projectDependencyIds ?? [])]
      .filter((id) => id !== plugin.id && byId.has(id))
      .map((id) => byId.get(id)!)
    if (!children.length) continue
    dependencies.set(plugin.id, children)
    for (const child of children)
      owners.set(child.id, [...(owners.get(child.id) ?? []), plugin.name])
  }
  return {
    roots: plugins.filter(
      (plugin) => !owners.has(plugin.id) || plugin.projectDependencyIds !== undefined
    ),
    dependencies,
    owners
  }
}
