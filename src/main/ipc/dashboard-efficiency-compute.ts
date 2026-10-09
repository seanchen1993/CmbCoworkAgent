import { isHarnessDevStageNodeName } from "../../shared/harness-stage-bucket"
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

export function readDevTrace(source: Record<string, unknown>): {
  precise: boolean
  unattributed: boolean
  metrics: EfficiencyDevComputeData | null
} {
  const precise =
    source.stageUsageSchemaVersion === 1 &&
    source.stageUsageComplete === true &&
    Array.isArray(source.stageUsage)
  const metrics = emptyDevCompute()
  if (precise) {
    const rows = (source.stageUsage as unknown[]).map(record)
    const unattributed = rows.some(
      (row) => !text(row.nodeName) && count(row.modelCalls) + count(row.toolCalls) > 0
    )
    const dev = rows.filter(
      (row) =>
        isHarnessDevStageNodeName(text(row.nodeName)) &&
        count(row.modelCalls) + count(row.toolCalls) > 0
    )
    if (dev.length === 0) return { precise, unattributed, metrics: null }
    for (const row of dev) {
      metrics.totalInputTokens += count(row.inputTokens)
      metrics.totalOutputTokens += count(row.outputTokens)
      metrics.totalTokens += count(row.totalTokens)
      metrics.modelCalls += count(row.modelCalls)
      metrics.tokenUsageReportedCalls += Math.min(
        count(row.tokenUsageReportedCalls),
        count(row.modelCalls)
      )
      // Missing historical cache fields are unknown, not a measured zero.
      if (
        typeof row.cacheReadTokens === "number" &&
        typeof row.cacheUsageReportedCalls === "number"
      ) {
        metrics.cacheReadTokens += count(row.cacheReadTokens)
        metrics.cacheUsageReportedCalls += Math.min(
          count(row.cacheUsageReportedCalls),
          count(row.modelCalls)
        )
      }
    }
    metrics.traceCount = 1
    return { precise, unattributed, metrics }
  }
  const nodeName = text(source.harnessNodeName)
  if (!isHarnessDevStageNodeName(nodeName))
    return { precise, unattributed: !nodeName, metrics: null }
  metrics.traceCount = 1
  metrics.totalInputTokens = count(source.totalInputTokens)
  metrics.totalOutputTokens = count(source.totalOutputTokens)
  metrics.totalTokens = resolveTokenTotal(
    source.totalTokens,
    metrics.totalInputTokens,
    metrics.totalOutputTokens
  )
  metrics.modelCalls = count(source.modelCallCount)
  // Historical turn totals do not prove per-call reporting or Dev-only cache coverage.
  return { precise, unattributed: false, metrics }
}

/** Both tokens and code use the same trace cohort (started in the selected period).
 * Code generated by those traces can be committed/pushed later. No event-time filter
 * is added: that would discard cross-period output while retaining its token spend.
 * Only counter fields are fetched, in bounded pages; no messages/model-call payloads.
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
  let after: unknown[] | undefined
  const cursors = new Set<string>()
  for (;;) {
    const raw = completeResponse(
      await query("trace", {
        size: PAGE_SIZE,
        track_total_hits: false,
        query: { bool: { filter: [...selectedTraceFilters, { exists: { field: "traceId" } }] } },
        sort: [{ traceId: "asc" }],
        ...(after ? { search_after: after } : {}),
        _source: {
          includes: [
            "traceId",
            "harnessProjectId",
            "harnessAdapterName",
            "harnessAdapterVersion",
            "harnessNodeName",
            "stageUsageSchemaVersion",
            "stageUsageComplete",
            "stageUsage",
            "totalInputTokens",
            "totalOutputTokens",
            "totalTokens",
            "modelCallCount"
          ]
        }
      })
    )
    const hits = record(raw.hits).hits
    if (!Array.isArray(hits)) throw new Error("研发阶段记录查询缺少结果，请重试")
    if (hits.length === 0) break
    const traces = new Map<
      string,
      {
        parsed: ReturnType<typeof readDevTrace>
        plugin: EfficiencyDevComputeResult["computeByPlugin"][number]
      }
    >()
    for (const hit of hits) {
      const source = record(record(hit)._source)
      const name = text(source.harnessAdapterName)
      const version = text(source.harnessAdapterVersion)
      if (name) {
        const versions = options.get(name) ?? new Set<string>()
        if (version) versions.add(version)
        options.set(name, versions)
      }
      if (selectedName && name !== selectedName) continue
      if (selectedVersion && version !== selectedVersion) continue
      coverage.scopeTraces += 1
      const parsed = readDevTrace(source)
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
      const id = text(source.traceId)
      if (!id || traces.has(id)) throw new Error("研发阶段记录标识缺失或重复，无法保证统计准确")
      traces.set(id, { parsed, plugin })
    }
    if (traces.size > 0) {
      const codeRaw = completeResponse(
        await query("event", {
          size: 0,
          query: {
            bool: {
              filter: [
                ...eventFilters,
                { terms: { "properties.traceId": [...traces.keys()] } },
                { terms: { eventName: ["code_gen", "code_adopt"] } },
                { regexp: { "properties.harnessNodeName": "[dD][eE][vV]-.*" } }
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
      const buckets = record(record(codeRaw.aggregations).by_trace)
      if (!Array.isArray(buckets.buckets) || count(buckets.sum_other_doc_count) > 0)
        throw new Error("研发阶段代码查询不完整，请重试")
      for (const value of buckets.buckets) {
        const bucket = record(value)
        const trace = traces.get(text(bucket.key))
        if (!trace?.parsed.metrics) continue
        const generated = record(bucket.generated)
        trace.parsed.metrics.generatedLines = sumValue(generated, "lines")
        trace.parsed.metrics.pushedAdoptedLines = sumValue(record(bucket.pushed), "lines")
        trace.parsed.metrics.codeProducingTraceCount = count(generated.doc_count) > 0 ? 1 : 0
      }
      for (const { parsed, plugin } of traces.values())
        addDevCompute(parsed.precise ? plugin.compute : plugin.legacyCompute, parsed.metrics!)
    }
    const last = record(hits[hits.length - 1])
    if (!Array.isArray(last.sort) || last.sort.length !== 1)
      throw new Error("研发阶段分页游标缺失，请重试")
    const cursor = JSON.stringify(last.sort)
    if (cursors.has(cursor)) throw new Error("研发阶段分页游标重复，请重试")
    cursors.add(cursor)
    after = last.sort
  }
  const compute = emptyDevCompute()
  const legacyCompute = emptyDevCompute()
  const rows = [...plugins.values()]
    .map((plugin) => {
      addDevCompute(compute, plugin.compute)
      addDevCompute(legacyCompute, plugin.legacyCompute)
      return {
        ...plugin,
        versions: plugin.versions.sort(),
        compute: finishDevCompute(plugin.compute),
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
    compute: finishDevCompute(compute),
    legacyCompute: finishDevCompute(legacyCompute),
    computeByPlugin: rows,
    computeCoverage: coverage,
    pluginOptions: [...options]
      .map(([adapterName, versions]) => ({ adapterName, versions: [...versions].sort() }))
      .sort((a, b) => a.adapterName.localeCompare(b.adapterName))
  }
}
