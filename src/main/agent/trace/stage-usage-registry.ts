import type { TraceContext } from "./types"
import type { TraceCallStage } from "../../../shared/trace-stage-usage"
import type { TraceStageUsageCounter } from "./stage-usage"
import { getHarnessStageAttributionForCall } from "../../services/harness-stage-attribution"

/**
 * How long a finished call waits for its call-start lookup. The lookup started together
 * with the call, and model calls take seconds, so it has normally finished by then; this
 * only bounds a slow or stuck adapter inspection.
 */
export const CALL_STAGE_SETTLE_MS = 200

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

/**
 * Start the stage lookup for a call that starts now. The caller does not wait for it
 * before the call: it runs the call and settles the lookup afterwards. Never rejects.
 */
export function startTraceCallStage(context: TraceContext | undefined): Promise<TraceCallStage> {
  const feature = context?.harnessFeature
  if (!feature) return Promise.resolve({})
  try {
    return getHarnessStageAttributionForCall(feature.projectId, feature.slug).then(
      (stage): TraceCallStage =>
        stage.nodeName && stage.nodeName.length <= 1024
          ? {
              nodeName: stage.nodeName,
              ...(stage.nodeStatus && stage.nodeStatus.length <= 256
                ? { nodeStatus: stage.nodeStatus }
                : {})
            }
          : {},
      () => ({})
    )
  } catch {
    return Promise.resolve({})
  }
}

/** The call-start stage once the call is done, or unattributed if the lookup is still running. */
export async function settleTraceCallStage(
  pending: Promise<TraceCallStage>,
  graceMs = CALL_STAGE_SETTLE_MS
): Promise<TraceCallStage> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<TraceCallStage>((resolve) => {
        timer = setTimeout(() => resolve({}), graceMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
