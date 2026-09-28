/**
 * What a tool ranking counts. "calls" once any trace in range carries complete per-tool
 * counts; "traces" (how many traces used each tool) when none does, which is all data from
 * before the collector and server rollout. One ranking never mixes the two.
 */
export type DashboardToolRankingMetric = "calls" | "traces"

export interface DashboardToolUsageCoverage {
  metric: DashboardToolRankingMetric
  /** False when the nested toolUsage aggregation did not run (mapping missing or conflicting). */
  available: boolean
  traceCount: number
  completeTraceCount: number
  /** Calls behind the filtered ranking. Always 0 for "traces": the count is unknown, not zero. */
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

const RANKING_TOP = 20
const RANKING_SIZE = 1000

/** One query/parser contract for the platform and project dashboards. */
export function buildToolUsageAggs(excludes: readonly string[]) {
  const totals = {
    calls: { sum: { field: "toolUsage.count" } },
    kinds: { cardinality: { field: "toolUsage.name", precision_threshold: 40000 } },
    by_name: {
      terms: {
        field: "toolUsage.name",
        size: RANKING_SIZE,
        shard_size: 2000,
        order: { calls: "desc" }
      },
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
    },
    // Traces that used each tool: the only per-tool signal older traces carry. `exclude`
    // drops terms, not documents, so a trace that also used read_file still counts.
    tool_usage_legacy_kinds: { cardinality: { field: "toolNames" } },
    tool_usage_legacy_all: { terms: { field: "toolNames", size: RANKING_SIZE } },
    tool_usage_legacy_filtered: {
      terms: { field: "toolNames", size: RANKING_SIZE, exclude: [...excludes] }
    }
  }
}

function sortedRanking(
  container: unknown,
  countOf: (bucket: Record<string, unknown>) => number
): Array<{ tool: string; count: number }> {
  const buckets = record(container).buckets
  return (Array.isArray(buckets) ? buckets : [])
    .map((value: unknown) => {
      const bucket = record(value)
      return { tool: String(bucket.key ?? "unknown"), count: countOf(bucket) }
    })
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
}

export function parseToolUsageAggs(value: unknown) {
  const aggs = record(value)
  const complete = record(aggs.tool_usage_complete)
  const usage = record(complete.usage)
  const filtered = record(usage.filtered)
  const traceCount = count(record(aggs.tool_usage_trace_docs).value)
  const completeTraceCount = count(complete.doc_count)
  const available = complete.usage !== undefined

  if (completeTraceCount > 0) {
    const callsOf = (bucket: Record<string, unknown>) => count(record(bucket.calls).value)
    const all = sortedRanking(usage.by_name, callsOf)
    const selected = sortedRanking(filtered.by_name, callsOf)
    return {
      byTool: selected.slice(0, RANKING_TOP),
      byToolAll: all.slice(0, RANKING_TOP),
      byToolFilteredAll: selected,
      byToolAllFull: all,
      totalTools: count(record(usage.kinds).value),
      totalToolCalls: count(record(usage.calls).value),
      toolUsageCoverage: {
        metric: "calls",
        available,
        traceCount,
        completeTraceCount,
        filteredCalls: count(record(filtered.calls).value),
        filteredTools: count(record(filtered.kinds).value),
        rankingTruncated:
          count(record(usage.by_name).sum_other_doc_count) > 0 ||
          count(record(filtered.by_name).sum_other_doc_count) > 0
      } satisfies DashboardToolUsageCoverage
    }
  }

  const tracesOf = (bucket: Record<string, unknown>) => count(bucket.doc_count)
  const all = sortedRanking(aggs.tool_usage_legacy_all, tracesOf)
  const selected = sortedRanking(aggs.tool_usage_legacy_filtered, tracesOf)
  return {
    byTool: selected.slice(0, RANKING_TOP),
    byToolAll: all.slice(0, RANKING_TOP),
    byToolFilteredAll: selected,
    byToolAllFull: all,
    totalTools: count(record(aggs.tool_usage_legacy_kinds).value),
    totalToolCalls: 0,
    toolUsageCoverage: {
      metric: "traces",
      available,
      traceCount,
      completeTraceCount,
      filteredCalls: 0,
      filteredTools: selected.length,
      rankingTruncated:
        count(record(aggs.tool_usage_legacy_all).sum_other_doc_count) > 0 ||
        count(record(aggs.tool_usage_legacy_filtered).sum_other_doc_count) > 0
    } satisfies DashboardToolUsageCoverage
  }
}

/** Column label for an exported ranking: a trace count must never be read as calls. */
export function toolRankingCountLabel(coverage: DashboardToolUsageCoverage | undefined): string {
  return coverage?.metric === "calls" ? "调用次数" : "用过该工具的 Trace 数"
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
