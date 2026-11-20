function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

export interface ProjectModeConstraintFileStat {
  path: string
  traceCount: number
}

export interface ProjectModeConstraintReadStats {
  traceCount: number
  successfulReadCount: number
  distinctFileCount: number
  filesTruncated: boolean
  files: ProjectModeConstraintFileStat[]
}

export interface ProjectModeHookEventStat {
  event: string
  count: number
}

export interface ProjectModeHookStats {
  executionCount: number
  blockedCount: number
  byEvent: ProjectModeHookEventStat[]
}

export interface ProjectModeOperationalStats {
  systemConstraintReads: ProjectModeConstraintReadStats | null
  hookExecutions: ProjectModeHookStats | null
}

/** Complete file / hook-type lists loaded only after the user opens a detail dialog. */
export interface ProjectModeOperationalDetails {
  constraintFiles: ProjectModeConstraintFileStat[]
  hookEvents: ProjectModeHookEventStat[]
}

/**
 * Build the operational sub-aggregations shared by stage, feature and project
 * buckets. Constraint summaries are emitted once per Trace x stage. Stage
 * buckets can therefore use doc_count exactly, while feature/project buckets
 * must cardinality-dedupe traceId across stages.
 */
export function buildProjectModeOperationalAggs(
  constraintFilters: Record<string, unknown>[],
  hookFilters: Record<string, unknown>[],
  options: {
    dedupeConstraintTraces?: boolean
    constraintFileLimit?: number
    hookEventLimit?: number
  } = {}
): Record<string, unknown> {
  const dedupeConstraintTraces = options.dedupeConstraintTraces === true
  const filesAgg: Record<string, unknown> = {
    terms: {
      field: "properties.constraintFiles",
      size: Math.max(1, options.constraintFileLimit ?? 20)
    }
  }
  if (dedupeConstraintTraces) {
    filesAgg.aggs = {
      trace_count: { cardinality: { field: "properties.traceId" } }
    }
  }

  return {
    system_constraint_reads: {
      filter: { bool: { filter: constraintFilters } },
      aggs: {
        ...(dedupeConstraintTraces
          ? { trace_count: { cardinality: { field: "properties.traceId" } } }
          : {}),
        successful_reads: { sum: { field: "properties.successfulReadCount" } },
        distinct_files: { cardinality: { field: "properties.constraintFiles" } },
        truncated_summaries: {
          filter: { term: { "properties.filesTruncated": true } }
        },
        files: filesAgg
      }
    },
    hook_executions: {
      filter: { bool: { filter: hookFilters } },
      aggs: {
        blocked: { filter: { term: { "properties.blocked": true } } },
        by_event: {
          terms: {
            field: "properties.event",
            size: Math.max(1, options.hookEventLimit ?? 32)
          }
        }
      }
    }
  }
}

/** Parse one ES bucket carrying buildProjectModeOperationalAggs sub-aggs. */
export function parseProjectModeOperationalStats(bucket: unknown): ProjectModeOperationalStats {
  const container = asRecord(bucket)
  const constraintReads = asRecord(container.system_constraint_reads)
  const constraintDocumentCount = asNumber(constraintReads.doc_count)
  let systemConstraintReads: ProjectModeConstraintReadStats | null = null
  if (constraintDocumentCount > 0) {
    const dedupedTraceCount = asNumber(asRecord(constraintReads.trace_count).value)
    const fileBuckets = asRecord(constraintReads.files).buckets
    systemConstraintReads = {
      traceCount: dedupedTraceCount > 0 ? dedupedTraceCount : constraintDocumentCount,
      successfulReadCount: asNumber(asRecord(constraintReads.successful_reads).value),
      distinctFileCount: asNumber(asRecord(constraintReads.distinct_files).value),
      filesTruncated: asNumber(asRecord(constraintReads.truncated_summaries).doc_count) > 0,
      files: Array.isArray(fileBuckets)
        ? fileBuckets
            .map((fileBucket) => {
              const file = asRecord(fileBucket)
              const dedupedFileTraceCount = asNumber(asRecord(file.trace_count).value)
              return {
                path: asString(file.key),
                traceCount:
                  dedupedFileTraceCount > 0 ? dedupedFileTraceCount : asNumber(file.doc_count)
              }
            })
            .filter((file) => Boolean(file.path))
        : []
    }
  }

  const hookExecutions = asRecord(container.hook_executions)
  const hookDocumentCount = asNumber(hookExecutions.doc_count)
  let hookStats: ProjectModeHookStats | null = null
  if (hookDocumentCount > 0) {
    const eventBuckets = asRecord(hookExecutions.by_event).buckets
    hookStats = {
      executionCount: hookDocumentCount,
      blockedCount: asNumber(asRecord(hookExecutions.blocked).doc_count),
      byEvent: Array.isArray(eventBuckets)
        ? eventBuckets
            .map((eventBucket) => ({
              event: asString(asRecord(eventBucket).key),
              count: asNumber(asRecord(eventBucket).doc_count)
            }))
            .filter((event) => Boolean(event.event))
        : []
    }
  }

  return { systemConstraintReads, hookExecutions: hookStats }
}
