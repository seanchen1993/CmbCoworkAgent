import type { HostProjectState } from "../../shared/project-runtime/host-types"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import type { PluginMetadata } from "../types"
import type { RuntimeActionSource } from "../plugins/runtime-source-scope"
import { assertProjectActionProviders, readProjectActionLock } from "./project-runtime/action-input"

/** Read the retained lock and the approved public catalog; this function grants nothing. */
export async function hostProjectActionSources(input: {
  root: string
  project: HostProjectState
  catalog(): Promise<ClawActionDescriptor[]>
  plugins(): readonly PluginMetadata[]
  assertCurrent(): void
}): Promise<RuntimeActionSource[]> {
  input.assertCurrent()
  const lock = readProjectActionLock(input.root, input.project.manifest)
  if (!lock.bindings.length) return []
  const catalog = await input.catalog()
  input.assertCurrent()
  assertProjectActionProviders(lock, catalog)
  const values = new Map<string, RuntimeActionSource>()
  for (const { ref } of lock.bindings) {
    if (ref.pluginId === input.project.installedPluginId) continue
    const previous = values.get(ref.pluginId)
    if (previous && (previous.name !== ref.plugin || previous.digest !== ref.digest))
      throw Error("PROJECT_ACTION_PROVIDER_CHANGED")
    const plugin = input.plugins().find(item => item.id === ref.pluginId)
    if (!plugin?.enabled) throw Error("PROJECT_ACTION_PROVIDER_CHANGED")
    values.set(ref.pluginId, { plugin: { ...plugin }, name: ref.plugin, digest: ref.digest })
  }
  input.assertCurrent()
  return [...values.values()]
}
