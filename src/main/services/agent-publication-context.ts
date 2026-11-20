import type { AgentMode } from "../agent/coordinator-mode"
import { getAgentModeFromMetadata } from "../agent/coordinator-mode"
import { workspaceIdentityEquals } from "./workspace-metadata"
import {
  matchesThreadIncarnation,
  type ThreadIncarnation,
  type ThreadIncarnationRow
} from "./thread-incarnation"

export interface AgentPublicationContext {
  workspacePath: string | undefined
  mode: AgentMode
  modeForcedByEnvironment?: boolean
  normalSubagentsEnabled: boolean
  threadIncarnation: ThreadIncarnation
}

export function matchesAgentPublicationContext(
  latestThread: ThreadIncarnationRow | null | undefined,
  latestMetadata: Record<string, unknown>,
  expected: AgentPublicationContext
): boolean {
  if (!matchesThreadIncarnation(latestThread, expected.threadIncarnation)) return false
  const latestWorkspacePath =
    typeof latestMetadata.workspacePath === "string" ? latestMetadata.workspacePath : undefined
  if (!workspaceIdentityEquals(latestWorkspacePath, expected.workspacePath)) return false
  if (expected.modeForcedByEnvironment) return true
  const latestMode = getAgentModeFromMetadata(latestMetadata)
  if (latestMode !== expected.mode) return false
  return (
    latestMode !== "normal" ||
    (latestMetadata.subagentsEnabled !== false) === expected.normalSubagentsEnabled
  )
}
