import type { EfficiencyDevComputeData } from "../../shared/dashboard-efficiency-compute"
import { buildComputeEfficiency } from "./dashboard-efficiency"

const PAGE_SIZE = 500
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

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
  target.tokenUsageIncomplete = Boolean(target.tokenUsageIncomplete || source.tokenUsageIncomplete)
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
