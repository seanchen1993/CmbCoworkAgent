import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {}

export interface FeatureExecutionMetrics {
  totalDurationMs: number | null
  lastExecutedAt: string | null
}

export const featureExecutionKey = (projectId: string, featureSlug: string): string =>
  JSON.stringify([projectId, featureSlug])

export function featureExecutionAggs(): Json {
  return {
    execution_duration: { stats: { field: "durationMs" } },
    last_execution: { max: { field: "startedAt" } }
  }
}

export function readLastExecution(container: unknown): string | null {
  const value = record(record(container).last_execution).value
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

export function readFeatureExecution(container: unknown): FeatureExecutionMetrics {
  const duration = record(record(container).execution_duration)
  return {
    totalDurationMs:
      Number(duration.count) > 0 &&
      typeof duration.sum === "number" &&
      Number.isFinite(duration.sum)
        ? Math.max(0, duration.sum)
        : null,
    lastExecutedAt: readLastExecution(container)
  }
}

/** Exact scalar-only fallback for overflowing terms; one sequential 500-bucket page at a time. */
export async function fetchCompleteFeatureExecution(
  ids: string[],
  filters: Json[],
  execute: (body: Json) => Promise<unknown>,
  expected?: Map<string, string[]>
): Promise<Map<string, FeatureExecutionMetrics>> {
  const result = new Map<string, FeatureExecutionMetrics>()
  const expectedSets = expected
    ? new Map([...expected].map(([id, slugs]) => [id, new Set(slugs)]))
    : undefined
  const scopeIds = expectedSets ? ids.filter((id) => expectedSets.get(id)?.size) : ids
  if (!scopeIds.length) return result
  const allowedIds = new Set(scopeIds)
  const featureFilters: Json[] = []
  if (expected) {
    for (const id of scopeIds) {
      const slugs = [...new Set(expected.get(id))]
      for (let offset = 0; offset < slugs.length; offset += 1000) {
        featureFilters.push({
          bool: {
            filter: [
              { term: { harnessProjectId: id } },
              { terms: { harnessFeatureSlug: slugs.slice(offset, offset + 1000) } }
            ]
          }
        })
      }
    }
  }
  let after: { project: string; feature: string } | undefined
  const seen = new Set<string>()
  for (;;) {
    const raw = record(
      await execute({
        size: 0,
        track_total_hits: false,
        query: {
          bool: {
            filter: [
              ...filters,
              { terms: { harnessProjectId: scopeIds } },
              ...(featureFilters.length
                ? [{ bool: { should: featureFilters, minimum_should_match: 1 } }]
                : [])
            ]
          }
        },
        aggs: {
          features: {
            composite: {
              size: 500,
              sources: [
                { project: { terms: { field: "harnessProjectId" } } },
                { feature: { terms: { field: "harnessFeatureSlug" } } }
              ],
              ...(after ? { after } : {})
            },
            aggs: featureExecutionAggs()
          }
        }
      })
    )
    assertProjectModeResultComplete(raw)
    const page = record(record(raw.aggregations).features)
    if (!Array.isArray(page.buckets)) throw new Error("特性执行统计未完整返回，请重试")
    for (const item of page.buckets) {
      const bucket = record(item)
      const key = record(bucket.key)
      if (
        typeof key.project !== "string" ||
        !allowedIds.has(key.project) ||
        typeof key.feature !== "string"
      ) {
        throw new Error("特性执行统计返回了范围外的数据")
      }
      if (expectedSets && !expectedSets.get(key.project)?.has(key.feature)) {
        throw new Error("特性执行统计返回了范围外的数据")
      }
      const id = featureExecutionKey(key.project, key.feature)
      if (result.has(id)) throw new Error("特性执行统计分页返回重复数据，请重试")
      result.set(id, readFeatureExecution(bucket))
    }
    if (!page.buckets.length) break
    if (page.after_key == null) {
      if (page.buckets.length >= 500) throw new Error("特性执行统计缺少后续分页游标，请重试")
      break
    }
    const next = record(page.after_key)
    if (
      Object.keys(next).length !== 2 ||
      typeof next.project !== "string" ||
      !allowedIds.has(next.project) ||
      typeof next.feature !== "string"
    ) {
      throw new Error("特性执行统计分页游标不完整，请重试")
    }
    const signature = featureExecutionKey(next.project, next.feature)
    if (seen.has(signature)) throw new Error("特性执行统计分页未前进，请重试")
    seen.add(signature)
    after = { project: next.project, feature: next.feature }
  }
  return result
}
