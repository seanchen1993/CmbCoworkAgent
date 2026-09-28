/** Call-start attribution; absent nodeName means the stage could not be resolved. */
export interface TraceCallStage {
  nodeName?: string
  nodeStatus?: string
}

export interface TraceStageUsage extends TraceCallStage {
  toolCalls: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  userInputRequests: number
  /** Calls with both input and output usage supplied. Missing usage is not a measured zero. */
  tokenUsageReportedCalls: number
}

export interface TraceStageUsageSnapshot {
  stageUsageSchemaVersion: 1
  /** All recorded totals are partitioned, including the explicit unattributed bucket. */
  stageUsageComplete: boolean
  stageUsage: TraceStageUsage[]
}

/** Response metadata survives graph-assigned IDs and IPC serialization. Never infer from time. */
export function readModelCallStage(
  value: unknown,
  traceId: string | undefined
): TraceCallStage | undefined {
  if (!traceId || !value || typeof value !== "object") return undefined
  const stamp = value as Record<string, unknown>
  if (stamp.version !== 1 || stamp.traceId !== traceId) return undefined
  if (
    stamp.nodeName !== undefined &&
    (typeof stamp.nodeName !== "string" || stamp.nodeName.length > 1024)
  )
    return undefined
  if (
    stamp.nodeStatus !== undefined &&
    (typeof stamp.nodeStatus !== "string" || stamp.nodeStatus.length > 256)
  )
    return undefined
  return {
    ...(typeof stamp.nodeName === "string" ? { nodeName: stamp.nodeName } : {}),
    ...(typeof stamp.nodeStatus === "string" ? { nodeStatus: stamp.nodeStatus } : {})
  }
}
