import type { PluginMetadata, SkillMetadata } from "@/types"

/** Display-only inventory. Native packages never become Claw function capabilities here. */
export interface NativePluginCapability {
  kind: "native-plugin"
  pluginId: string
  name: string
  version: string
  description: string
  enabled: boolean
  /** Only the native legacy-board entry flag; Skill isolation metadata grants no UI route. */
  projectMode: boolean
  installedSkillCount: number
  hasFunctionCapabilities: boolean
  businessModCount: number
  businessExtensionCount: number
  skills: Array<{ id: string; name: string }>
}

export function nativePluginCapabilities(
  plugins: readonly PluginMetadata[],
  skills: readonly SkillMetadata[],
  functionPluginIds: readonly string[]
): NativePluginCapability[] {
  const functions = new Set(functionPluginIds)
  return plugins
    .filter(
      (plugin) =>
        !functions.has(plugin.id) ||
        plugin.hasProjectMode ||
        plugin.skillCount > 0 ||
        plugin.mcpServerCount > 0 ||
        (plugin.hookCount ?? 0) > 0 ||
        skills.some((skill) => skill.pluginId === plugin.id)
    )
    .map((plugin) => {
      const owned = skills.filter((skill) => skill.pluginId === plugin.id)
      return {
        kind: "native-plugin",
        pluginId: plugin.id,
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        enabled: plugin.enabled,
        projectMode: plugin.hasProjectMode === true,
        installedSkillCount: plugin.skillCount,
        hasFunctionCapabilities: functions.has(plugin.id),
        businessModCount: plugin.businessModCount ?? 0,
        businessExtensionCount: plugin.businessExtensionCount ?? 0,
        skills: plugin.enabled
          ? owned.map((skill) => ({ id: skill.id ?? skill.path, name: skill.name }))
          : []
      }
    })
}
