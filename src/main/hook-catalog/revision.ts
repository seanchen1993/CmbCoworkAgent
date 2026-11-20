import { normalizeWorkspacePathKey } from "../../shared/workspace-path"

let globalRevision = 0
const workspaceRevisions = new Map<string, number>()

export function getHookCatalogGlobalRevision(): number {
  return globalRevision
}

export function bumpHookCatalogGlobalRevision(): number {
  globalRevision += 1
  return globalRevision
}

export function getHookCatalogWorkspaceRevision(workspacePath?: string): number {
  if (!workspacePath) return 0
  return workspaceRevisions.get(normalizeWorkspacePathKey(workspacePath)) ?? 0
}

export function bumpHookCatalogWorkspaceRevision(workspacePath: string): number {
  const key = normalizeWorkspacePathKey(workspacePath)
  const next = (workspaceRevisions.get(key) ?? 0) + 1
  workspaceRevisions.set(key, next)
  return next
}

export function resetHookCatalogRevisionsForTests(): void {
  globalRevision = 0
  workspaceRevisions.clear()
}
