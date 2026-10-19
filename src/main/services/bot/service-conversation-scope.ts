import { PartnerLocalFault } from "./partner-local-boundary"
import type { PartnerLocalClient } from "./partner-local-client"
import { ServiceConversationStore, type ServiceScope } from "./service-conversation-store"
/** One upgrade-time verification; no history probes in renderer refresh loops. */
export async function prepareServiceConversationScope(
  store: ServiceConversationStore,
  scope: ServiceScope,
  client: PartnerLocalClient
): Promise<void> {
  const oldScopes = store.legacyScopes(scope)
  if (oldScopes.some((candidate) => !candidate.tasks.length && candidate.hasLocalIntent))
    throw new PartnerLocalFault("SCOPE_MIGRATION_CONFLICT")
  const candidates = oldScopes.filter((candidate) => candidate.tasks.length)
  // An empty old URL cannot prove ownership of this database. A populated
  // candidate must prove every immutable Task and source Run under current
  // credentials. Multiple populated histories require explicit resolution.
  if (candidates.length > 1) throw new PartnerLocalFault("SCOPE_MIGRATION_CONFLICT")
  const candidate = candidates[0]
  if (!candidate) return
  for (let i = 0; i < candidate.tasks.length; i += 40) {
    const batch = candidate.tasks.slice(i, i + 40)
    await client.expertConversationSummaries(
      scope.groupId,
      scope.botId,
      batch.map((t) => t.id)
    )
    for (const task of batch) {
      if (!task.runId) throw new PartnerLocalFault("SCOPE_MIGRATION_CONFLICT")
      const { run } = await client.inspect(task.runId)
      if (
        run.taskId !== task.id ||
        run.groupId !== scope.groupId ||
        run.botId !== scope.botId ||
        run.requesterPrincipalId !== scope.businessPrincipalId ||
        run.nodeId !== scope.nodeId ||
        run.workspaceRef !== scope.workspaceRef ||
        run.ownerPrincipalId !== scope.ownerPrincipalId
      )
        throw new PartnerLocalFault("FORBIDDEN")
    }
  }
  store.migrateScope(candidate.key, scope)
}
