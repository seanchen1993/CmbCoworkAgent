import type { ModObject } from "../../../shared/mods/types"

/** Main-only host data routing for an explicitly created recovery branch. No execution grant. */
export interface ProjectRecoveryContext {
  directory: string
  knowledgeRoot?: string
  /** Frozen declared non-sensitive inputs only. Never sealed fields or secret defaults. */
  configuration?: ModObject
  assertCurrent(): void
}
type Resolver = (
  workspace: string,
  plugin: { name: string; version: string }
) => ProjectRecoveryContext | undefined
const resolvers = new Set<Resolver>()
export function registerProjectRecoveryContextResolver(resolve: Resolver): () => void {
  resolvers.add(resolve)
  return () => {
    resolvers.delete(resolve)
  }
}
export function readProjectRecoveryContext(
  workspace: string,
  plugin: { name: string; version: string }
): ProjectRecoveryContext | undefined {
  for (const resolve of resolvers) {
    const found = resolve(workspace, plugin)
    if (found) {
      found.assertCurrent()
      return found
    }
  }
  return undefined
}
