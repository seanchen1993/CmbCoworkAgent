import type {
  EfficiencyDevComputeData,
  EfficiencyDevComputeResult,
  EfficiencyPluginFilter
} from "../../shared/dashboard-efficiency-compute"
import {
  addDevCompute,
  emptyDevCompute,
  fetchEfficiencyPluginOptions,
  finishDevCompute
} from "./dashboard-efficiency-compute"
import {
  COMPUTE_STAGES,
  codeStageAggs,
  emptyComputeStages,
  readCodeStages,
  readTraceStages,
  reconcileComputeStages,
  traceStageAggs
} from "./dashboard-efficiency-stages"
import { isNestedMappingError } from "./dashboard-es-nested-mapping"
import { resolveTokenTotal } from "./dashboard-token-totals"

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const sum = (bucket: Record<string, unknown>, key: string): number =>
  count(record(bucket[key]).value)
// Bound nested buckets as well as plugin keys (compatible with ES bucket limits).
const PAGE_SIZE = 100

function checked(value: unknown): Record<string, unknown> {
  const raw = record(value)
  if (raw.timed_out || count(record(raw._shards).failed) > 0 || !raw.aggregations)
    throw new Error("全流程算力统计查询不完整，请重试")
  return record(raw.aggregations)
}

const traceAggs = {
  trace_count: { value_count: { field: "traceId" } },
  input: { sum: { field: "totalInputTokens" } },
  output: { sum: { field: "totalOutputTokens" } },
  total: { sum: { field: "totalTokens" } },
  cache: { sum: { field: "cacheReadTokens" } },
  model_calls: { sum: { field: "modelCallCount" } },
  cache_reported: {
    filter: { exists: { field: "cacheReadTokens" } },
    aggs: { calls: { sum: { field: "modelCallCount" } } }
  }
}
const codeAggs = {
  generated: {
    filter: { term: { eventName: "code_gen" } },
    aggs: {
      lines: { sum: { field: "properties.lineCount" } },
      traces: { cardinality: { field: "properties.traceId" } }
    }
  },
  pushed: {
    filter: {
      bool: {
        filter: [{ term: { eventName: "code_adopt" } }, { term: { "properties.pushed": true } }]
      }
    },
    aggs: { lines: { sum: { field: "properties.adoptedLineCount" } } }
  }
}

function traceMetrics(bucket: Record<string, unknown>): EfficiencyDevComputeData {
  const data = emptyDevCompute()
  data.traceCount = sum(bucket, "trace_count")
  data.totalInputTokens = sum(bucket, "input")
  data.totalOutputTokens = sum(bucket, "output")
  data.totalTokens = resolveTokenTotal(
    record(bucket.total).value,
    data.totalInputTokens,
    data.totalOutputTokens
  )
  data.cacheReadTokens = sum(bucket, "cache")
  data.modelCalls = sum(bucket, "model_calls")
  // All-mode keeps the previous trace-level usage semantics; it makes no claim
  // that historical per-call token/cache metadata was complete.
  data.cacheUsageReportedCalls = sum(record(bucket.cache_reported), "calls")
  return data
}
function codeMetrics(
  bucket: Record<string, unknown>
): Pick<
  EfficiencyDevComputeData,
  "generatedLines" | "pushedAdoptedLines" | "codeProducingTraceCount"
> {
  return {
    generatedLines: sum(record(bucket.generated), "lines"),
    pushedAdoptedLines: sum(record(bucket.pushed), "lines"),
    codeProducingTraceCount: sum(record(bucket.generated), "traces")
  }
}

/** Full mode preserves the original windows: trace.startedAt, code_gen.eventTime,
 * code_adopt.generatedAt + pushed=true. Dev selects a partition of these same
 * aggregates, so cross-month records use identical rules in both views.
 */
export async function fetchEfficiencyCompute(
  query: (index: "trace" | "event", body: Record<string, unknown>) => Promise<unknown>,
  traceFilters: Record<string, unknown>[],
  eventFilters: Record<string, unknown>[],
  range: { from: string; to: string },
  selection: EfficiencyPluginFilter = {}
): Promise<EfficiencyDevComputeResult> {
  const name = text(selection.adapterName)
  const version = name ? text(selection.adapterVersion) : ""
  const options = new Map<string, Set<string>>()
  const rows = new Map<string, EfficiencyDevComputeResult["computeByPlugin"][number]>()
  const total = emptyDevCompute()
  const stages = emptyComputeStages()
  const legacyStages = emptyComputeStages()
  const pluginStages = new Map<string, ReturnType<typeof emptyComputeStages>>()
  const scope = selection.scope ?? "all"
  const pluginFilters = (prefix: string) => [
    ...(name ? [{ term: { [`${prefix}harnessAdapterName`]: name } }] : []),
    ...(version ? [{ term: { [`${prefix}harnessAdapterVersion`]: version } }] : [])
  ]
  const timeFilter = (field: string) => ({ range: { [field]: { gte: range.from, lte: range.to } } })
  const scopedQuery = (index: "trace" | "event", scoped: Record<string, unknown>[]) =>
    index === "trace"
      ? { bool: { filter: scoped } }
      : {
          bool: {
            filter: scoped,
            minimum_should_match: 1,
            should: [
              {
                bool: { filter: [{ term: { eventName: "code_gen" } }, timeFilter("eventTime")] }
              },
              {
                bool: {
                  filter: [
                    { term: { eventName: "code_adopt" } },
                    timeFilter("properties.generatedAt"),
                    { exists: { field: "properties.adoptedLineCount" } },
                    { exists: { field: "properties.generatedLineCount" } },
                    { exists: { field: "properties.effectiveGeneratedLineCount" } }
                  ]
                }
              }
            ]
          }
        }
  if (name) {
    const optionMaps = await Promise.all([
      fetchEfficiencyPluginOptions(query, "trace", scopedQuery("trace", traceFilters)),
      fetchEfficiencyPluginOptions(
        query,
        "event",
        scopedQuery("event", eventFilters),
        "properties."
      )
    ])
    for (const map of optionMaps)
      for (const [adapter, versions] of map) {
        const combined = options.get(adapter) ?? new Set<string>()
        for (const value of versions) combined.add(value)
        options.set(adapter, combined)
      }
  }
  await Promise.all(
    (["trace", "event"] as const).map(async (index) => {
      let legacyOnly = false
      let after: Record<string, unknown> | undefined
      const cursors = new Set<string>()
      let first = true
      for (;;) {
        const prefix = index === "trace" ? "" : "properties."
        const scoped = [
          ...(index === "trace" ? traceFilters : eventFilters),
          ...pluginFilters(prefix)
        ]
        const queryBody = scopedQuery(index, scoped)
        const makeBody = () => {
          const base = index === "trace" ? traceAggs : codeAggs
          const aggs = {
            ...base,
            ...(index === "trace" ? traceStageAggs(base, legacyOnly) : codeStageAggs(base))
          }
          return {
            size: 0,
            track_total_hits: false,
            query: queryBody,
            aggs: {
              ...(first ? { overall: { filter: { match_all: {} }, aggs } } : {}),
              plugins: {
                composite: {
                  size: PAGE_SIZE,
                  sources: [
                    {
                      adapter: {
                        terms: { field: `${prefix}harnessAdapterName`, missing_bucket: true }
                      }
                    },
                    {
                      version: {
                        terms: { field: `${prefix}harnessAdapterVersion`, missing_bucket: true }
                      }
                    }
                  ],
                  ...(after ? { after } : {})
                },
                aggs
              }
            }
          }
        }
        let response: unknown
        try {
          response = await query(index, makeBody())
        } catch (error) {
          if (index !== "trace" || legacyOnly || !isNestedMappingError(error, "stageUsage"))
            throw error
          legacyOnly = true
          response = await query(index, makeBody())
        }
        const raw = checked(response)
        // Validate the page before consuming its totals.
        const pluginAgg = record(raw.plugins)
        if (!Array.isArray(pluginAgg.buckets)) throw new Error("全流程插件查询缺少结果，请重试")
        const readStages = (bucket: Record<string, unknown>) => {
          return index === "event"
            ? { stages: readCodeStages(bucket, codeMetrics), legacy: null }
            : readTraceStages(bucket, traceMetrics, legacyOnly)
        }
        if (first) {
          if (!raw.overall) throw new Error("全流程汇总结果缺失，请重试")
          addDevCompute(
            total,
            index === "trace"
              ? traceMetrics(record(raw.overall))
              : Object.assign(emptyDevCompute(), codeMetrics(record(raw.overall)))
          )
          const overallStages = readStages(record(raw.overall))
          for (const stage of COMPUTE_STAGES)
            addDevCompute(stages[stage], overallStages.stages[stage])
          if (overallStages.legacy)
            for (const stage of COMPUTE_STAGES)
              addDevCompute(legacyStages[stage], overallStages.legacy[stage])
        }
        for (const value of pluginAgg.buckets) {
          const bucket = record(value)
          const key = record(bucket.key)
          const adapter = text(key.adapter)
          const bucketVersion = text(key.version)
          if (adapter) {
            const versions = options.get(adapter) ?? new Set<string>()
            if (bucketVersion) versions.add(bucketVersion)
            options.set(adapter, versions)
          }
          const row = rows.get(adapter) ?? {
            adapterName: adapter || null,
            versions: [],
            compute: emptyDevCompute(),
            legacyCompute: emptyDevCompute()
          }
          if (bucketVersion && !row.versions.includes(bucketVersion))
            row.versions.push(bucketVersion)
          const metrics =
            index === "trace"
              ? traceMetrics(bucket)
              : Object.assign(emptyDevCompute(), codeMetrics(bucket))
          addDevCompute(row.compute, metrics)
          const partitions = pluginStages.get(adapter) ?? emptyComputeStages()
          const parsedStages = readStages(bucket)
          for (const stage of COMPUTE_STAGES)
            addDevCompute(partitions[stage], parsedStages.stages[stage])
          if (parsedStages.legacy) addDevCompute(row.legacyCompute, parsedStages.legacy.dev)
          pluginStages.set(adapter, partitions)
          rows.set(adapter, row)
        }
        first = false
        const next = record(pluginAgg.after_key)
        if (!pluginAgg.buckets.length || pluginAgg.buckets.length < PAGE_SIZE) break
        if (!Object.keys(next).length) throw new Error("全流程插件分页游标缺失，请重试")
        const cursor = JSON.stringify(next)
        if (cursors.has(cursor)) throw new Error("全流程插件分页游标重复，请重试")
        cursors.add(cursor)
        after = next
      }
    })
  )
  reconcileComputeStages(total, stages)
  return {
    computeScope: scope,
    compute: finishDevCompute(scope === "all" ? total : stages.dev),
    legacyCompute: scope === "all" ? emptyDevCompute() : finishDevCompute(legacyStages.dev),
    stageDistribution: COMPUTE_STAGES.map((stage) => ({
      stage,
      totalTokens: stages[stage].totalTokens,
      generatedLines: stages[stage].generatedLines,
      pushedAdoptedLines: stages[stage].pushedAdoptedLines
    })),
    computeByPlugin: [...rows.values()]
      .map((row) => {
        const partitions = pluginStages.get(row.adapterName ?? "")!
        reconcileComputeStages(row.compute, partitions)
        return {
          ...row,
          versions: row.versions.sort(),
          compute: finishDevCompute(scope === "all" ? row.compute : partitions.dev),
          legacyCompute: scope === "all" ? emptyDevCompute() : finishDevCompute(row.legacyCompute)
        }
      })
      .sort((a, b) => b.compute.totalTokens - a.compute.totalTokens),
    computeCoverage: {
      scopeTraces: total.traceCount,
      preciseDevTraces: Math.max(0, stages.dev.traceCount - legacyStages.dev.traceCount),
      legacyDevTraces: legacyStages.dev.traceCount,
      unattributedTraces: stages.unattributed.traceCount
    },
    pluginOptions: [...options]
      .map(([adapterName, versions]) => ({ adapterName, versions: [...versions].sort() }))
      .sort((a, b) => a.adapterName.localeCompare(b.adapterName))
  }
}

/** Compatibility name for the full-flow query; selection can also request its Dev partition. */
export const fetchFullCompute = fetchEfficiencyCompute
