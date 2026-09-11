import { nowIsoLocal } from "../util/local-time"
import { trackEvent, type EventCategory } from "./event-reporter"

export const SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT = "harness.system_constraint.read_summary"
const MAX_PENDING_TRACES = 2_048
const MAX_PENDING_AGE_MS = 6 * 60 * 60 * 1_000
const PRUNE_INTERVAL_MS = 60 * 1_000

export interface SystemConstraintReadRecord {
  traceId: string
  rootTraceId?: string
  rootThreadId?: string
  threadId?: string
  agentId?: string
  harnessProjectId: string
  harnessFeatureSlug: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  pluginId?: string
  pluginName?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
  constraintFile: string
}

interface SummaryBucket {
  context: Omit<SystemConstraintReadRecord, "constraintFile">
  constraintFiles: Set<string>
  successfulReadCount: number
  firstReadAt: string
  lastReadAt: string
  updatedAtMs: number
}

type SummaryEventEmitter = (
  eventName: string,
  eventCategory: EventCategory,
  properties?: Record<string, unknown>
) => void

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function summaryBucketKey(record: SystemConstraintReadRecord): string {
  return record.harnessNodeName?.trim() ?? ""
}

/**
 * Run-scoped accumulator. One event is emitted per trace and workflow stage,
 * regardless of how many pages or duplicate files `read_file` returned.
 */
export class SystemConstraintReadAccumulator {
  private readonly pending = new Map<string, Map<string, SummaryBucket>>()
  private lastPrunedAtMs = 0

  record(input: SystemConstraintReadRecord): void {
    const traceId = normalize(input.traceId)
    const harnessProjectId = normalize(input.harnessProjectId)
    const harnessFeatureSlug = normalize(input.harnessFeatureSlug)
    const constraintFile = normalize(input.constraintFile)
    if (!traceId || !harnessProjectId || !harnessFeatureSlug || !constraintFile) return

    const nowMs = Date.now()
    this.pruneExpired(nowMs)
    let traceBuckets = this.pending.get(traceId)
    if (!traceBuckets) {
      while (this.pending.size >= MAX_PENDING_TRACES) this.evictOldestTrace()
      traceBuckets = new Map()
      this.pending.set(traceId, traceBuckets)
    }

    const normalizedRecord: SystemConstraintReadRecord = {
      ...input,
      traceId,
      harnessProjectId,
      harnessFeatureSlug,
      constraintFile
    }
    const key = summaryBucketKey(normalizedRecord)
    const now = nowIsoLocal()
    const existing = traceBuckets.get(key)
    if (existing) {
      existing.constraintFiles.add(constraintFile)
      existing.successfulReadCount += 1
      existing.lastReadAt = now
      existing.updatedAtMs = nowMs
      return
    }

    traceBuckets.set(key, {
      context: {
        traceId,
        rootTraceId: normalize(input.rootTraceId),
        rootThreadId: normalize(input.rootThreadId),
        threadId: normalize(input.threadId),
        agentId: normalize(input.agentId),
        harnessProjectId,
        harnessFeatureSlug,
        harnessNodeName: normalize(input.harnessNodeName),
        harnessNodeStatus: normalize(input.harnessNodeStatus),
        pluginId: normalize(input.pluginId),
        pluginName: normalize(input.pluginName),
        harnessAdapterName: normalize(input.harnessAdapterName),
        harnessAdapterVersion: normalize(input.harnessAdapterVersion)
      },
      constraintFiles: new Set([constraintFile]),
      successfulReadCount: 1,
      firstReadAt: now,
      lastReadAt: now,
      updatedAtMs: nowMs
    })
  }

  flushTrace(
    traceIdInput: string,
    outcome?: string,
    emit: SummaryEventEmitter = trackEvent
  ): number {
    const traceId = normalize(traceIdInput)
    if (!traceId) return 0
    const traceBuckets = this.pending.get(traceId)
    if (!traceBuckets) return 0
    this.pending.delete(traceId)

    let emitted = 0
    for (const bucket of traceBuckets.values()) {
      const constraintFiles = [...bucket.constraintFiles].sort((a, b) => a.localeCompare(b))
      emit(SYSTEM_CONSTRAINT_READ_SUMMARY_EVENT, "harness", {
        ...bucket.context,
        constraintFiles,
        successfulReadCount: bucket.successfulReadCount,
        distinctFileCount: constraintFiles.length,
        filesTruncated: false,
        firstReadAt: bucket.firstReadAt,
        lastReadAt: bucket.lastReadAt,
        ...(normalize(outcome) ? { traceOutcome: normalize(outcome) } : {})
      })
      emitted += 1
    }
    return emitted
  }

  clear(): void {
    this.pending.clear()
    this.lastPrunedAtMs = 0
  }

  private pruneExpired(nowMs: number): void {
    if (nowMs - this.lastPrunedAtMs < PRUNE_INTERVAL_MS) return
    this.lastPrunedAtMs = nowMs
    const cutoff = nowMs - MAX_PENDING_AGE_MS
    for (const [traceId, buckets] of this.pending) {
      const newest = Math.max(...[...buckets.values()].map((bucket) => bucket.updatedAtMs))
      if (newest < cutoff) this.pending.delete(traceId)
    }
  }

  private evictOldestTrace(): void {
    const oldestTraceId = this.pending.keys().next().value as string | undefined
    if (oldestTraceId) this.pending.delete(oldestTraceId)
  }
}

const accumulator = new SystemConstraintReadAccumulator()

export function recordSystemConstraintRead(record: SystemConstraintReadRecord): void {
  accumulator.record(record)
}

export function flushSystemConstraintReadSummaries(traceId: string, outcome?: string): number {
  return accumulator.flushTrace(traceId, outcome)
}
