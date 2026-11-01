import type { PluginMetadata } from "../types"
import { readProjectRuntimeDescription } from "../harness-board/project-runtime/description"
import { readProjectActionLock } from "../harness-board/project-runtime/action-input"

/** Display-only grouping. Never changes the installed catalogue or grants runtime access. */
export async function readProjectDependencyIds(
  plugin: Pick<PluginMetadata, "id" | "path">,
  installedIds: ReadonlySet<string>
): Promise<string[] | undefined> {
  try {
    const description = await readProjectRuntimeDescription(plugin.path)
    if (description?.status !== "ready" || description.manifest.mode !== "host") return undefined
    const lock = readProjectActionLock(plugin.path, description.manifest)
    return [...new Set(lock.bindings.map((binding) => binding.ref.pluginId))]
      .filter((id) => id !== plugin.id && installedIds.has(id))
      .sort()
  } catch {
    // Invalid/incomplete declarations must not hide otherwise ordinary installed plugins.
    return undefined
  }
}
