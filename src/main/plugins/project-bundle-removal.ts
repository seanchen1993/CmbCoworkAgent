import type { PluginMetadata } from "../types"

/** Only exclusive component packages may follow their project's uninstall. */
export function projectBundleRemovalIds(
  targetId: string,
  plugins: readonly PluginMetadata[],
  dependencies: ReadonlyMap<string, readonly string[]>
): string[] {
  const referencedElsewhere = new Set(
    [...dependencies].filter(([id]) => id !== targetId).flatMap(([, ids]) => [...ids])
  )
  if (referencedElsewhere.has(targetId)) {
    throw Error("此组件仍被其他项目插件使用，请先卸载引用它的项目插件。")
  }
  const candidates = new Set(dependencies.get(targetId) ?? [])
  return [
    targetId,
    ...plugins
      .filter(
        (plugin) =>
          plugin.id !== targetId &&
          candidates.has(plugin.id) &&
          !referencedElsewhere.has(plugin.id) &&
          !dependencies.has(plugin.id) &&
          plugin.dependencyOnly !== false
      )
      .map((plugin) => plugin.id)
  ]
}
