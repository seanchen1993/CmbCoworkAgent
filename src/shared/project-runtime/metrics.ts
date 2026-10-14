import type { HostProjectOperation } from "./host-types"

export interface LocalProjectMetrics {
  retainedOperations: number
  failed: number
  unknown: number
  repeatedExecutions: number
  observedExecutionMs: number | null
  observedApprovalWaitMs: number | null
  measuredExecutions: number
}
/** Counts durable host facts only. Missing clocks/usage are not zero-duration or free runs. */
export function projectLocalMetrics(
  operations: readonly HostProjectOperation[]
): LocalProjectMetrics {
  const unique = [
    ...new Map(operations.map((operation) => [operation.operationId, operation])).values()
  ]
  const executions = new Map<string, number>()
  const elapsed: number[] = [],
    waiting: number[] = []
  for (const operation of unique) {
    if (operation.startedAt !== null) {
      const key = `${operation.stageId}:${operation.expectedVersion}`
      executions.set(key, (executions.get(key) ?? 0) + 1)
      const end = operation.execution?.terminal?.settledAt
      if (
        end !== undefined &&
        Number.isFinite(end) &&
        Number.isFinite(operation.startedAt) &&
        end >= operation.startedAt
      )
        elapsed.push(end - operation.startedAt)
    }
    if (operation.approval && operation.approval.decidedAt >= operation.createdAt)
      waiting.push(operation.approval.decidedAt - operation.createdAt)
  }
  return {
    retainedOperations: unique.length,
    failed: unique.filter((operation) => operation.status === "failed").length,
    unknown: unique.filter((operation) => operation.status === "unknown").length,
    repeatedExecutions: [...executions.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0
    ),
    observedExecutionMs: elapsed.length ? elapsed.reduce((total, ms) => total + ms, 0) : null,
    observedApprovalWaitMs: waiting.length ? waiting.reduce((total, ms) => total + ms, 0) : null,
    measuredExecutions: elapsed.length
  }
}
