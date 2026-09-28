import type { TraceContext } from "./types"
import type { TraceCallStage } from "../../../shared/trace-stage-usage"
import type { TraceStageUsageCounter } from "./stage-usage"
import { getHarnessStageAttributionForCall } from "../../services/harness-stage-attribution"

const counters = new Map<string, TraceStageUsageCounter>()

export function registerTraceStageUsage(traceId: string, counter: TraceStageUsageCounter): void {
  // Bound abandoned collectors too. Eviction only makes subsequent calls unattributed.
  if (counters.size >= 2048) counters.delete(counters.keys().next().value as string)
  counters.set(traceId, counter)
}

export function unregisterTraceStageUsage(traceId: string): void {
  counters.delete(traceId)
}
export function getTraceStageUsage(
  traceId: string | undefined
): TraceStageUsageCounter | undefined {
  return traceId ? counters.get(traceId) : undefined
}

export async function captureTraceCallStage(
  context: TraceContext | undefined
): Promise<TraceCallStage> {
  const feature = context?.harnessFeature
  if (!feature) return {}
  try {
    const stage = await getHarnessStageAttributionForCall(feature.projectId, feature.slug)
    return stage.nodeName && stage.nodeName.length <= 1024
      ? {
          nodeName: stage.nodeName,
          ...(stage.nodeStatus && stage.nodeStatus.length <= 256
            ? { nodeStatus: stage.nodeStatus }
            : {})
        }
      : {}
  } catch {
    return {}
  }
}
