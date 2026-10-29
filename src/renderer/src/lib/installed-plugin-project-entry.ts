import type { LocalProjectTemplate } from "../../../shared/project-runtime/platform-api"

export interface InstalledProjectPlugin {
  id: string
  name: string
  version?: string
  enabled: boolean
  hasProjectMode?: boolean
  path?: string
  updatedAt?: string
}

export type InstalledPluginProjectEntry =
  | { kind: "host"; pluginId: string; name: string; version: string }
  | { kind: "legacy"; pluginId: string; name: string; version?: string }
  | { kind: "unavailable"; reason: string }

const identity = (item: InstalledProjectPlugin) =>
  JSON.stringify([
    item.id,
    item.name,
    item.version,
    item.enabled,
    item.hasProjectMode,
    item.path,
    item.updatedAt
  ])

export function classifyInstalledPluginProjectEntry(
  pluginId: string,
  plugins: readonly InstalledProjectPlugin[],
  templates: readonly LocalProjectTemplate[]
): InstalledPluginProjectEntry {
  const plugin = plugins.find((item) => item.id === pluginId)
  if (!plugin) return { kind: "unavailable", reason: "这个插件已卸载或不再可用。" }
  if (!plugin.enabled) return { kind: "unavailable", reason: "先启用这个插件，再打开项目入口。" }
  const matches = templates.filter((item) => item.installedPluginId === pluginId)
  if (matches.length) {
    const template = matches[0]
    if (matches.length !== 1 || !plugin.version || template.version !== plugin.version)
      return { kind: "unavailable", reason: "插件版本与项目模板已变化，请重新检查入口。" }
    if (template.unavailableReason)
      return { kind: "unavailable", reason: "这个本地项目模板暂不可用，请检查插件后重试。" }
    // The native template's name is its actual package identity, not a copy's display label.
    return { kind: "host", pluginId, name: template.name, version: template.version }
  }
  if (plugin.hasProjectMode)
    return { kind: "legacy", pluginId, name: plugin.name, version: plugin.version }
  return { kind: "unavailable", reason: "这个插件没有项目入口，可在聊天中使用它提供的功能。" }
}

/** Recheck the installed identity after asynchronous template discovery, never infer from previews. */
export async function readInstalledPluginProjectEntry(
  pluginId: string,
  api: {
    plugins(): Promise<readonly InstalledProjectPlugin[]>
    templates(): Promise<readonly LocalProjectTemplate[]>
  },
  isCurrent: () => boolean,
  expected?: InstalledProjectPlugin
): Promise<InstalledPluginProjectEntry> {
  const guard = () => {
    if (!isCurrent()) throw Error("配置聊天或目录已变化，请重新打开项目入口。")
  }
  guard()
  const before = await api.plugins()
  guard()
  const first = before.find((item) => item.id === pluginId)
  if (expected && (!first || identity(first) !== identity(expected)))
    throw Error("插件版本或状态已变化，请重新检查项目入口。")
  if (!first?.enabled) return classifyInstalledPluginProjectEntry(pluginId, before, [])
  const templates = await api.templates()
  guard()
  const after = await api.plugins()
  guard()
  const current = after.find((item) => item.id === pluginId)
  if (!current?.enabled) return classifyInstalledPluginProjectEntry(pluginId, after, [])
  if (identity(first) !== identity(current))
    throw Error("插件版本或状态已变化，请重新检查项目入口。")
  return classifyInstalledPluginProjectEntry(pluginId, after, templates)
}
