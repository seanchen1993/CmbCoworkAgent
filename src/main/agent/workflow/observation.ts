import type { PersistedWorkflowRun } from "./types"
import type { ModJson } from "../../../shared/mods/types"

/** A bounded projection of the original store, never a second workflow state holder. */
export function observeWorkflowRun(
  run: PersistedWorkflowRun,
  options: { agentOffset?: number; worktreeOffset?: number; limit?: number } = {}
) {
  const agentOffset = options.agentOffset ?? 0,
    worktreeOffset = options.worktreeOffset ?? 0
  const limit = options.limit ?? 16
  for (const value of [agentOffset, worktreeOffset, limit])
    if (!Number.isSafeInteger(value) || value < 0) throw Error("WORKFLOW_OBSERVATION_PAGE_INVALID")
  if (limit < 1 || limit > 32) throw Error("WORKFLOW_OBSERVATION_PAGE_INVALID")
  const agents = run.agents.slice(agentOffset, agentOffset + limit).map((agent) => ({
    index: agent.index,
    label: agent.label.slice(0, 160),
    phase: agent.phase?.slice(0, 160) ?? null,
    status: agent.status,
    outputTokens: agent.outputTokens,
    startedAt: agent.startedAt.slice(0, 40),
    endedAt: agent.endedAt?.slice(0, 40) ?? null
  }))
  const worktrees = (run.worktrees ?? [])
    .slice(worktreeOffset, worktreeOffset + limit)
    .map((worktree) => ({
      id: worktree.id.slice(0, 160),
      agentIndex: worktree.agentIndex ?? null,
      branch: worktree.branch.slice(0, 200),
      directory: worktree.workspaceDirectory.slice(0, 512),
      directoryTruncated: worktree.workspaceDirectory.length > 512,
      status: worktree.status,
      dirty: worktree.dirty,
      cleanupPending: worktree.cleanupPending ?? false,
      baseCommit: worktree.baseCommit,
      headCommit: worktree.headCommit ?? null,
      updatedAt: worktree.updatedAt.slice(0, 40),
      resource: worktree.resource ? {
        id: worktree.resource.id,
        generation: worktree.resource.generation,
        state: worktree.resource.state,
        budgets: Buffer.byteLength(JSON.stringify(worktree.resource.budgets ?? [])) <= 8000
          ? JSON.parse(JSON.stringify(worktree.resource.budgets ?? [])) as ModJson : [],
        budgetsTruncated: Buffer.byteLength(JSON.stringify(worktree.resource.budgets ?? [])) > 8000,
        workspaceRef: worktree.resource.workspaceRef ?? null,
        sealedCommit: worktree.resource.sealedCommit ?? null
      } : null,
      integrationCommit: worktree.integrationCommit ?? null
    }))
  const result = {
    runId: run.runId.slice(0, 160),
    scriptSha256: run.scriptSha256,
    nativeParent: run.nativeParent ?? null,
    hostExecution: run.hostExecution ? { ...run.hostExecution } : null,
    result: Buffer.byteLength(JSON.stringify(run.result ?? null)) <= 6000
      ? JSON.parse(JSON.stringify(run.result ?? null)) as ModJson : null,
    resultTruncated: Buffer.byteLength(JSON.stringify(run.result ?? null)) > 6000 ||
      run.resultSidecarStatus === "available" || run.resultSidecarStatus === "unavailable",
    status: run.status,
    name: run.workflowName.slice(0, 160),
    phase: run.currentPhase?.slice(0, 160) ?? null,
    startedAt: run.startedAt.slice(0, 40),
    updatedAt: run.updatedAt.slice(0, 40),
    completedAt: run.completedAt?.slice(0, 40) ?? null,
    agents,
    worktrees,
    agentCount: run.agents.length,
    worktreeCount: run.worktrees?.length ?? 0,
    agentOffset,
    worktreeOffset,
    nextAgentOffset: null as number | null,
    nextWorktreeOffset: null as number | null,
    hasMore: false
  }
  // Match the original capability hub's 16 KB state limit; pagination keeps all rows reachable.
  while (
    Buffer.byteLength(JSON.stringify(result)) > 9_000 &&
    (agents.length || worktrees.length)
  ) {
    if (agents.length > worktrees.length || !worktrees.length) agents.pop()
    else if (worktrees.length === 1 && worktrees[0].resource &&
        !worktrees[0].resource.budgetsTruncated &&
        JSON.stringify(worktrees[0].resource.budgets) !== "[]") {
      // A single large history must advance pagination with an explicit incomplete fact.
      worktrees[0].resource.budgets = []
      worktrees[0].resource.budgetsTruncated = true
    } else worktrees.pop()
  }
  result.nextAgentOffset =
    agentOffset + agents.length < run.agents.length ? agentOffset + agents.length : null
  result.nextWorktreeOffset =
    worktreeOffset + worktrees.length < (run.worktrees?.length ?? 0)
      ? worktreeOffset + worktrees.length
      : null
  // This is a complete page of metadata, not truncated command output.
  // Individual shortened paths retain their own explicit directoryTruncated flag.
  result.hasMore =
    result.nextAgentOffset !== null ||
    result.nextWorktreeOffset !== null
  return result
}

export type WorkflowRunObservation = ReturnType<typeof observeWorkflowRun>
