import { completeStageUsageFilter } from "./project-mode-stage-usage"
import { isNestedMappingError } from "./dashboard-es-nested-mapping"
import type {
  EfficiencyDevComputeData,
  EfficiencyDevComputeResult,
  EfficiencyPluginFilter
} from "../../shared/dashboard-efficiency-compute"
import { buildComputeEfficiency } from "./dashboard-efficiency"
import { resolveTokenTotal } from "./dashboard-token-totals"

const PAGE_SIZE = 500
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
const sumValue = (bucket: Record<string, unknown>, key: string): number =>
  count(record(bucket[key]).value)

function completeResponse(value: unknown): Record<string, unknown> {
  const raw = record(value)
  if (raw.timed_out || count(record(raw._shards).failed) > 0)
    throw new Error("研发阶段算力统计查询不完整，请重试")
  return raw
}

export function emptyDevCompute(): EfficiencyDevComputeData {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    tokenTotalsConsistent: true,
    generatedLines: 0,
    pushedAdoptedLines: 0,
    tokensPerGeneratedLine: null,
    tokensPerAdoptedLine: null,
    traceCount: 0,
    codeProducingTraceCount: 0,
    codeProducingTraceRatio: null,
    modelCalls: 0,
    tokenUsageReportedCalls: 0,
    cacheUsageReportedCalls: 0
  }
}

/** Ratios always come from summed numerators/denominators, never averaged plugin ratios. */
export function finishDevCompute(data: EfficiencyDevComputeData): EfficiencyDevComputeData {
  return {
    ...data,
    ...buildComputeEfficiency(data),
    tokensPerGeneratedLine: data.generatedLines > 0 ? data.totalTokens / data.generatedLines : null
  }
}

export function addDevCompute(
  target: EfficiencyDevComputeData,
  source: EfficiencyDevComputeData
): void {
  for (const field of [
    "totalInputTokens",
    "totalOutputTokens",
    "totalTokens",
    "cacheReadTokens",
    "generatedLines",
    "pushedAdoptedLines",
    "traceCount",
    "codeProducingTraceCount",
    "modelCalls",
    "tokenUsageReportedCalls",
    "cacheUsageReportedCalls"
  ] as const)
    target[field] += source[field]
}

/** Metadata-only composite pages keep plugin choices complete without loading trace payloads. */
export async function fetchEfficiencyPluginOptions(
  query: (index: "trace" | "event", body: Record<string, unknown>) => Promise<unknown>,
  index: "trace" | "event",
  queryBody: Record<string, unknown>,
  prefix = ""
): Promise<Map<string, Set<string>>> {
  const options = new Map<string, Set<string>>()
  let after: Record<string, unknown> | undefined
  const cursors = new Set<string>()
  for (;;) {
    const raw = completeResponse(
      await query(index, {
        size: 0,
        track_total_hits: false,
        query: queryBody,
        aggs: {
          plugins: {
            composite: {
              size: PAGE_SIZE,
              sources: [
                {
                  adapter: { terms: { field: `${prefix}harnessAdapterName`, missing_bucket: true } }
                },
                {
                  version: {
                    terms: { field: `${prefix}harnessAdapterVersion`, missing_bucket: true }
                  }
                }
              ],
              ...(after ? { after } : {})
            }
          }
        }
      })
    )
    const agg = record(record(raw.aggregations).plugins)
    if (!Array.isArray(agg.buckets)) throw new Error("插件选项查询缺少结果，请重试")
    for (const value of agg.buckets) {
      const key = record(record(value).key)
      const name = text(key.adapter)
      if (!name) continue
      const versions = options.get(name) ?? new Set<string>()
      if (text(key.version)) versions.add(text(key.version))
      options.set(name, versions)
    }
    const next = record(agg.after_key)
    if (!agg.buckets.length || !Object.keys(next).length) break
    const cursor = JSON.stringify(next)
    if (cursors.has(cursor)) throw new Error("插件选项分页游标重复，请重试")
    cursors.add(cursor)
    after = next
  }
  return options
}

const TRACE_PAGE_SIZE = 1000
const CODE_CONCURRENCY = 4
const devNodeFilter = (field: string) => ({ regexp: { [field]: "[dD][eE][vV]-.*" } })
const stageActivityFilter = {
  bool: {
    should: [
      { range: { "stageUsage.modelCalls": { gt: 0 } } },
      { range: { "stageUsage.toolCalls": { gt: 0 } } }
    ],
    minimum_should_match: 1
  }
}
const usageFields = {
  totalInputTokens: "inputTokens",
  totalOutputTokens: "outputTokens",
  totalTokens: "totalTokens",
  modelCalls: "modelCalls",
  tokenUsageReportedCalls: "tokenUsageReportedCalls",
  cacheReadTokens: "cacheReadTokens",
  cacheUsageReportedCalls: "cacheUsageReportedCalls"
}

function devTraceAggs(legacyOnly: boolean): Record<string, unknown> {
  return {
    ...(!legacyOnly
      ? {
          precise: {
            filter: completeStageUsageFilter,
            aggs: {
              usage: {
                nested: { path: "stageUsage" },
                aggs: {
                  dev: {
                    filter: {
                      bool: { filter: [devNodeFilter("stageUsage.nodeName"), stageActivityFilter] }
                    },
                    aggs: Object.fromEntries(
                      Object.entries(usageFields).map(([key, field]) => [
                        key,
                        { sum: { field: `stageUsage.${field}` } }
                      ])
                    )
                  },
                  unattributed: {
                    filter: {
                      bool: {
                        filter: [stageActivityFilter],
                        must_not: [{ exists: { field: "stageUsage.nodeName" } }]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      : {}),
    legacy: {
      filter: {
        bool: {
          filter: [devNodeFilter("harnessNodeName")],
          ...(!legacyOnly ? { must_not: [completeStageUsageFilter] } : {})
        }
      },
      aggs: {
        ...Object.fromEntries(
          ["totalInputTokens", "totalOutputTokens", "totalTokens", "cacheReadTokens"].map((key) => [
            key,
            { sum: { field: key } }
          ])
        ),
        modelCalls: { sum: { field: "modelCallCount" } },
        cache_reported: {
          filter: { exists: { field: "cacheReadTokens" } },
          aggs: { calls: { sum: { field: "modelCallCount" } } }
        }
      }
    }
  }
}

function readDevBucket(bucket: Record<string, unknown>): {
  precise: boolean
  unattributed: boolean
  metrics: EfficiencyDevComputeData | null
} {
  const scope = record(bucket.precise)
  const precise = count(scope.doc_count) > 0
  const usage = record(scope.usage)
  const dev = record(usage.dev)
  const legacy = record(bucket.legacy)
  const unattributed = count(record(usage.unattributed).doc_count) > 0
  if (count(precise ? dev.doc_count : legacy.doc_count) === 0)
    return { precise, unattributed, metrics: null }
  const metrics = emptyDevCompute()
  const source = precise ? dev : legacy
  for (const field of Object.keys(usageFields) as (keyof typeof usageFields)[])
    metrics[field] = sumValue(source, field)
  if (!precise) {
    metrics.totalTokens = resolveTokenTotal(
      record(source.totalTokens).value,
      metrics.totalInputTokens,
      metrics.totalOutputTokens
    )
    metrics.cacheUsageReportedCalls = sumValue(record(source.cache_reported), "calls")
  }
  metrics.traceCount = 1
  return { precise, unattributed, metrics }
}

/** Existing Dev records remain visible; complete new records still contribute only Dev calls.
 * Coverage markers describe missing per-call reports, not the age of a record.
 */
export function mergeDevCompute(
  precise: EfficiencyDevComputeData,
  legacy: EfficiencyDevComputeData
): EfficiencyDevComputeData {
  const merged = emptyDevCompute()
  addDevCompute(merged, precise)
  addDevCompute(merged, legacy)
  merged.tokenUsageIncomplete = precise.tokenUsageReportedCalls < precise.modelCalls
  return finishDevCompute(merged)
}

/** Both counters and code retain the same trace cohort. Composite aggregation reads
 * indexed counters instead of decompressing full trace sources; bounded concurrent
 * code batches overlap the next trace page without per-trace requests.
 */
export async function fetchDevCompute(
  query: (index: "trace" | "event", body: Record<string, unknown>) => Promise<unknown>,
  traceFilters: Record<string, unknown>[],
  eventFilters: Record<string, unknown>[],
  selection: EfficiencyPluginFilter = {}
): Promise<EfficiencyDevComputeResult> {
  const selectedName = text(selection.adapterName)
  const selectedVersion = selectedName ? text(selection.adapterVersion) : ""
  const options = selectedName
    ? await fetchEfficiencyPluginOptions(query, "trace", { bool: { filter: traceFilters } })
    : new Map<string, Set<string>>()
  const selectedTraceFilters = [
    ...traceFilters,
    ...(selectedName ? [{ term: { harnessAdapterName: selectedName } }] : []),
    ...(selectedVersion ? [{ term: { harnessAdapterVersion: selectedVersion } }] : [])
  ]
  const plugins = new Map<string, EfficiencyDevComputeResult["computeByPlugin"][number]>()
  const coverage = {
    scopeTraces: 0,
    preciseDevTraces: 0,
    legacyDevTraces: 0,
    unattributedTraces: 0
  }
  const cursors = new Set<string>()
  const pending = new Set<Promise<void>>()
  let codeFailure: unknown
  let codeFailed = false
  let legacyOnly = false
  let after: Record<string, unknown> | undefined

  async function applyCode(
    traces: Map<
      string,
      {
        parsed: ReturnType<typeof readDevBucket>
        plugin: EfficiencyDevComputeResult["computeByPlugin"][number]
      }
    >
  ): Promise<void> {
    const legacyIds = [...traces].filter(([, row]) => !row.parsed.precise).map(([id]) => id)
    const stageFilter = {
      bool: {
        should: [
          devNodeFilter("properties.harnessNodeName"),
          ...(legacyIds.length
            ? [
                {
                  bool: {
                    filter: [{ terms: { "properties.traceId": legacyIds } }],
                    must_not: [{ exists: { field: "properties.harnessNodeName" } }]
                  }
                }
              ]
            : [])
        ],
        minimum_should_match: 1
      }
    }
    const raw = completeResponse(
      await query("event", {
        size: 0,
        query: {
          bool: {
            filter: [
              ...eventFilters,
              { terms: { "properties.traceId": [...traces.keys()] } },
              { terms: { eventName: ["code_gen", "code_adopt"] } },
              stageFilter
            ]
          }
        },
        aggs: {
          by_trace: {
            terms: { field: "properties.traceId", size: traces.size },
            aggs: {
              generated: {
                filter: { term: { eventName: "code_gen" } },
                aggs: { lines: { sum: { field: "properties.lineCount" } } }
              },
              pushed: {
                filter: {
                  bool: {
                    filter: [
                      { term: { eventName: "code_adopt" } },
                      { term: { "properties.pushed": true } },
                      { exists: { field: "properties.adoptedLineCount" } },
                      { exists: { field: "properties.generatedLineCount" } },
                      { exists: { field: "properties.effectiveGeneratedLineCount" } }
                    ]
                  }
                },
                aggs: { lines: { sum: { field: "properties.adoptedLineCount" } } }
              }
            }
          }
        }
      })
    )
    const agg = record(record(raw.aggregations).by_trace)
    if (!Array.isArray(agg.buckets) || count(agg.sum_other_doc_count) > 0)
      throw new Error("研发阶段代码查询不完整，请重试")
    for (const value of agg.buckets) {
      const bucket = record(value)
      const row = traces.get(text(bucket.key))
      if (!row?.parsed.metrics) continue
      const generated = record(bucket.generated)
      row.parsed.metrics.generatedLines = sumValue(generated, "lines")
      row.parsed.metrics.pushedAdoptedLines = sumValue(record(bucket.pushed), "lines")
      row.parsed.metrics.codeProducingTraceCount = count(generated.doc_count) > 0 ? 1 : 0
    }
    for (const { parsed, plugin } of traces.values())
      addDevCompute(parsed.precise ? plugin.compute : plugin.legacyCompute, parsed.metrics!)
  }

  try {
    for (;;) {
      if (codeFailed) throw codeFailure
      const body = () => ({
        size: 0,
        track_total_hits: false,
        query: { bool: { filter: selectedTraceFilters } },
        aggs: {
          by_trace: {
            composite: {
              size: TRACE_PAGE_SIZE,
              sources: [
                { id: { terms: { field: "traceId" } } },
                { adapter: { terms: { field: "harnessAdapterName", missing_bucket: true } } },
                { version: { terms: { field: "harnessAdapterVersion", missing_bucket: true } } }
              ],
              ...(after ? { after } : {})
            },
            aggs: devTraceAggs(legacyOnly)
          }
        }
      })
      let raw: Record<string, unknown>
      try {
        raw = completeResponse(await query("trace", body()))
      } catch (error) {
        if (legacyOnly || !isNestedMappingError(error, "stageUsage")) throw error
        legacyOnly = true
        raw = completeResponse(await query("trace", body()))
      }
      const agg = record(record(raw.aggregations).by_trace)
      if (!Array.isArray(agg.buckets)) throw new Error("研发阶段记录查询缺少结果，请重试")
      if (!agg.buckets.length) break
      const next = record(agg.after_key)
      if (!Object.keys(next).length && agg.buckets.length >= TRACE_PAGE_SIZE)
        throw new Error("研发阶段分页游标缺失，请重试")
      if (Object.keys(next).length) {
        const cursor = JSON.stringify(next)
        if (cursors.has(cursor)) throw new Error("研发阶段分页游标重复，请重试")
        cursors.add(cursor)
      }
      const traces = new Map<
        string,
        {
          parsed: ReturnType<typeof readDevBucket>
          plugin: EfficiencyDevComputeResult["computeByPlugin"][number]
        }
      >()
      for (const value of agg.buckets) {
        const bucket = record(value)
        if (count(bucket.doc_count) !== 1) throw new Error("研发阶段记录标识重复，无法保证统计准确")
        const key = record(bucket.key)
        const name = text(key.adapter)
        const version = text(key.version)
        if (name) {
          const versions = options.get(name) ?? new Set<string>()
          if (version) versions.add(version)
          options.set(name, versions)
        }
        coverage.scopeTraces += count(bucket.doc_count)
        const parsed = readDevBucket(bucket)
        if (parsed.unattributed) coverage.unattributedTraces += 1
        if (!parsed.metrics) continue
        if (parsed.precise) coverage.preciseDevTraces += 1
        else coverage.legacyDevTraces += 1
        const plugin = plugins.get(name) ?? {
          adapterName: name || null,
          versions: [],
          compute: emptyDevCompute(),
          legacyCompute: emptyDevCompute()
        }
        if (version && !plugin.versions.includes(version)) plugin.versions.push(version)
        plugins.set(name, plugin)
        const id = text(key.id)
        if (!id || traces.has(id)) throw new Error("研发阶段记录标识缺失或重复，无法保证统计准确")
        traces.set(id, { parsed, plugin })
      }
      if (traces.size) {
        const operation = applyCode(traces).catch((error) => {
          if (!codeFailed) codeFailure = error
          codeFailed = true
        })
        pending.add(operation)
        void operation.then(() => pending.delete(operation))
        if (pending.size >= CODE_CONCURRENCY) await Promise.race(pending)
      }
      if (agg.buckets.length < TRACE_PAGE_SIZE || !Object.keys(next).length) break
      after = next
    }
  } finally {
    // Drain bounded in-flight queries even if a later trace page fails.
    await Promise.all(pending)
  }
  if (codeFailed) throw codeFailure
  const precise = emptyDevCompute()
  const legacy = emptyDevCompute()
  const rows = [...plugins.values()]
    .map((plugin) => {
      addDevCompute(precise, plugin.compute)
      addDevCompute(legacy, plugin.legacyCompute)
      return {
        ...plugin,
        versions: plugin.versions.sort(),
        compute: mergeDevCompute(plugin.compute, plugin.legacyCompute),
        legacyCompute: finishDevCompute(plugin.legacyCompute)
      }
    })
    .sort(
      (a, b) =>
        b.compute.totalTokens - a.compute.totalTokens ||
        (a.adapterName ?? "").localeCompare(b.adapterName ?? "")
    )
  return {
    computeScope: "dev",
    compute: mergeDevCompute(precise, legacy),
    legacyCompute: finishDevCompute(legacy),
    computeByPlugin: rows,
    computeCoverage: coverage,
    pluginOptions: [...options]
      .map(([adapterName, versions]) => ({ adapterName, versions: [...versions].sort() }))
      .sort((a, b) => a.adapterName.localeCompare(b.adapterName))
  }
}
