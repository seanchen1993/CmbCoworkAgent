export interface DashboardToolUsageCoverage {
  available: boolean
  traceCount: number
  completeTraceCount: number
  filteredCalls: number
  filteredTools: number
  rankingTruncated: boolean
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0

/** One query/parser contract for the platform and project dashboards. */
export function buildToolUsageAggs(excludes: readonly string[]) {
  const totals = {
    calls: { sum: { field: "toolUsage.count" } },
    kinds: { cardinality: { field: "toolUsage.name", precision_threshold: 40000 } },
    by_name: {
      terms: { field: "toolUsage.name", size: 1000, shard_size: 2000, order: { calls: "desc" } },
      aggs: { calls: { sum: { field: "toolUsage.count" } } }
    }
  }
  return {
    tool_usage_trace_docs: { value_count: { field: "traceId" } },
    tool_usage_complete: {
      filter: {
        bool: {
          filter: [{ term: { toolUsageSchemaVersion: 1 } }, { term: { toolUsageComplete: true } }]
        }
      },
      aggs: {
        usage: {
          nested: { path: "toolUsage" },
          aggs: {
            ...totals,
            filtered: {
              filter: { bool: { must_not: [{ terms: { "toolUsage.name": excludes } }] } },
              aggs: totals
            }
          }
        }
      }
    }
  }
}

export function parseToolUsageAggs(value: unknown) {
  const aggs = record(value)
  const complete = record(aggs.tool_usage_complete)
  const usage = record(complete.usage)
  const filtered = record(usage.filtered)
  const ranking = (container: Record<string, unknown>) => {
    const buckets = record(container.by_name).buckets
    return (Array.isArray(buckets) ? buckets : [])
      .map((value: unknown) => {
        const bucket = record(value)
        return { tool: String(bucket.key ?? "unknown"), count: count(record(bucket.calls).value) }
      })
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  }
  const all = ranking(usage)
  const selected = ranking(filtered)
  return {
    byTool: selected.slice(0, 20),
    byToolAll: all.slice(0, 20),
    byToolFilteredAll: selected,
    byToolAllFull: all,
    totalTools: count(record(usage.kinds).value),
    totalToolCalls: count(record(usage.calls).value),
    toolUsageCoverage: {
      available: complete.usage !== undefined,
      traceCount: count(record(aggs.tool_usage_trace_docs).value),
      completeTraceCount: count(complete.doc_count),
      filteredCalls: count(record(filtered.calls).value),
      filteredTools: count(record(filtered.kinds).value),
      rankingTruncated:
        count(record(usage.by_name).sum_other_doc_count) > 0 ||
        count(record(filtered.by_name).sum_other_doc_count) > 0
    } satisfies DashboardToolUsageCoverage
  }
}

/** Zero is a value. Never replace it with a count from truncated raw nodes. */
export function resolveUserInputRequestCount(
  indexed: unknown,
  raw: unknown,
  fallback: number
): number {
  for (const value of [indexed, raw]) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return fallback
}
