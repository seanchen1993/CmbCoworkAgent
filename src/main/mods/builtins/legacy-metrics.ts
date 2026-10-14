import type { ManagedRunSnapshot } from "../../../shared/harness-board-types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"
import type {
  BuiltinLegacyMetrics,
  BuiltinPolicyScope
} from "../../../shared/mods/builtin-policy-metrics"
import type {
  LegacyProjectOperation,
  LegacyProjectRuntimeBinding
} from "../../../shared/project-runtime/legacy-operations"

type Reader = (scope: BuiltinPolicyScope) => BuiltinLegacyMetrics
let reader: Reader | undefined
export function registerBuiltinLegacyMetricsReader(next: Reader) {
  reader = next
  return () => {
    if (reader === next) reader = undefined
  }
}
export function readBuiltinLegacyMetrics(scope: BuiltinPolicyScope): BuiltinLegacyMetrics {
  try {
    return reader?.(scope) ?? { state: "unavailable" }
  } catch {
    return { state: "unavailable" }
  }
}
/** Original execution receipts are not original business-stage validation receipts. */
export function projectLegacyExecutionMetrics(
  scope: BuiltinPolicyScope,
  projectId: string,
  featureId: string,
  binding: LegacyProjectRuntimeBinding | undefined,
  operations: readonly LegacyProjectOperation[],
  managedRun?: ManagedRunSnapshot
): BuiltinLegacyMetrics {
  const fixedBinding =
    binding?.projectId === projectId && isSameWorkspacePath(scope.workspace, binding.workspace)
      ? binding
      : undefined
  const managed =
    managedRun?.projectId === projectId &&
    managedRun.featureId === featureId &&
    isSameWorkspacePath(
      managedRun.workspacePath ?? managedRun.currentSession?.workspacePath,
      scope.workspace
    )
      ? managedRun
      : undefined
  if (!fixedBinding && !managed) return { state: "unavailable" }
  const timestamp = (value: string | undefined) =>
    value ? Date.parse(`${value.replace(" ", "T")}+08:00`) : NaN
  const managedDuration = managed?.completedAt
    ? timestamp(managed.completedAt) - timestamp(managed.startedAt)
    : NaN
  const matched = [
    ...new Map(
      operations
        .filter(
          (operation) =>
            operation.projectId === projectId &&
            operation.featureId === featureId &&
            operation.installedPluginId === fixedBinding?.installedPluginId &&
            operation.packageDigest === fixedBinding?.packageDigest &&
            isSameWorkspacePath(operation.workspace, scope.workspace)
        )
        .map((operation) => [operation.operationId, operation])
    ).values()
  ]
  const executions = matched
    .slice(0, 100)
    .map((operation) => ({
      operationId: operation.operationId,
      threadId: operation.threadId,
      status: operation.status,
      startedAt: operation.startedAt,
      settledAt: operation.settledAt,
      durationMs:
        operation.status !== "unknown" &&
        operation.status !== "started" &&
        operation.settledAt !== null &&
        operation.settledAt >= operation.startedAt
          ? operation.settledAt - operation.startedAt
          : null,
      source: "original-runtime-ledger" as const
    }))
  const counts = { started: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }
  executions.forEach((row) => counts[row.status]++)
  const intervals = executions
    .filter((row) => row.durationMs !== null)
    .map((row) => [row.startedAt, row.settledAt!] as const)
    .sort((a, b) => a[0] - b[0])
  let total = 0,
    start: number | undefined,
    end = 0
  for (const interval of intervals) {
    if (start === undefined) {
      start = interval[0]
      end = interval[1]
    } else if (interval[0] <= end) end = Math.max(end, interval[1])
    else {
      total += end - start
      start = interval[0]
      end = interval[1]
    }
  }
  if (start !== undefined) total += end - start
  return {
    state: "observed",
    projectId,
    featureId,
    scope: "retained-original-executions",
    executions,
    counts,
    ...(managed
      ? {
          managedRun: {
            runId: managed.runId,
            nodeId: managed.decisionBaseline?.nodeId ?? null,
            status: managed.status,
            currentThreadId: managed.currentSession?.threadId ?? null,
            durationMs:
              Number.isFinite(managedDuration) && managedDuration >= 0 ? managedDuration : null,
            providerRetries: managed.providerRetryCount,
            source: "original-managed-run-snapshot" as const
          }
        }
      : {}),
    observedExecutionSpanMs: intervals.length
      ? Math.max(...intervals.map((row) => row[1])) - intervals[0][0]
      : null,
    totalSettledExecutionMs: intervals.length ? total : null,
    repeatedExecutions: Math.max(0, executions.length - 1),
    approvalWaitMs: null,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    businessStateValidity: "unknown",
    limited: operations.length >= 100,
    explanation:
      "当前Feature固定来源账本的原运行回执及会话关联的原托管快照；托管时长单列、不与账本叠加，托管完成不代表业务验证通过。同阶段重复运行不一定是失败重试。已结算执行时间按区间并集合计，未知执行不计入；不证明业务阶段通过。审批等待、用量和费用缺少关联事实。"
  }
}
