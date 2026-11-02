import type { ProjectActionLock } from "../../shared/project-runtime/action-bindings"

/** Display-only identities from an already validated lock, never names or execution grants. */
export function projectDependencyIdsFromLock(
  pluginId: string,
  lock: ProjectActionLock,
  installedIds: ReadonlySet<string>
): string[] {
  return [...new Set(lock.bindings.map((binding) => binding.ref.pluginId))]
    .filter((id) => id !== pluginId && installedIds.has(id))
    .sort()
}
