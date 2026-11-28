import type { ProjectMetricPeriodCode } from "../../shared/project-metrics"
import { normalizeCodeStatsFromContainer } from "./dashboard-code-stats"
import { assertProjectModeResultComplete } from "./project-mode-query-scope"

type Row = Record<string, unknown>
const record = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {}

/** 按代码上报组织和 Harness 项目聚合，调用方再合并企业项目。按室导出时也发现有生成但未 Push 的组。 */
export async function fetchProjectMetricPeriodCode(
  query: (index: string, body: Row) => Promise<unknown>,
  eventIndex: string,
  adoptionFilters: Row[],
  pushedAggregation: unknown,
  includeGroup = false,
  generationFilters?: Row[]
): Promise<ProjectMetricPeriodCode[]> {
  const result: ProjectMetricPeriodCode[] = []
  const cursors = new Set<string>()
  const pushedFilters = [...adoptionFilters, { term: { "properties.pushed": true } }]
  const activity = generationFilters
    ? {
        should: [generationFilters, adoptionFilters].map((filter) => ({ bool: { filter } })),
        minimum_should_match: 1
      }
    : { filter: pushedFilters }
  let after: Row | undefined
  for (;;) {
    const body = {
      size: 0,
      query: { bool: activity },
      aggs: {
        project_code: {
          composite: {
            size: 500,
            sources: [
              { room: { terms: { field: "upperOrgLv1", missing_bucket: true } } },
              ...(includeGroup
                ? [{ group: { terms: { field: "upperOrgLv0", missing_bucket: true } } }]
                : []),
              { project: { terms: { field: "properties.harnessProjectId" } } }
            ],
            ...(after ? { after } : {})
          },
          aggs: { code_adopt_pushed: pushedAggregation }
        }
      }
    }
    console.log(
      `[Dashboard][ProjectMetrics][ES] 周期代码项目依据\nindex: ${eventIndex}\ndsl: ${JSON.stringify(body)}`
    )
    const raw = await query(eventIndex, body)
    assertProjectModeResultComplete(raw)
    const page = record(record(record(raw).aggregations).project_code)
    if (!Array.isArray(page.buckets)) throw new Error("周期代码项目依据未完整返回")
    for (const value of page.buckets) {
      const bucket = record(value)
      const key = record(bucket.key)
      if (typeof key.project !== "string" || !key.project)
        throw new Error("周期代码项目依据缺少项目编号")
      if (!bucket.code_adopt_pushed) throw new Error("周期代码项目依据缺少采纳统计")
      const pushedCount = record(bucket.code_adopt_pushed).doc_count
      if (generationFilters && typeof pushedCount !== "number")
        throw new Error("周期代码项目依据缺少 Push 记录数")
      const stats = normalizeCodeStatsFromContainer(bucket)
      result.push({
        harnessProjectId: key.project,
        roomName: typeof key.room === "string" ? key.room : "",
        ...(includeGroup ? { groupName: typeof key.group === "string" ? key.group : "" } : {}),
        ...(generationFilters && typeof pushedCount === "number"
          ? { hasPushedCode: pushedCount > 0 }
          : {}),
        pushedAdoptedLines: stats.pushedAdoptedLines,
        pushedEffectiveGeneratedLines: stats.pushedEffectiveGeneratedLines
      })
    }
    if (!page.buckets.length || !page.after_key) break
    after = record(page.after_key)
    const cursor = JSON.stringify(after)
    if (
      !Object.hasOwn(after, "room") ||
      (includeGroup && !Object.hasOwn(after, "group")) ||
      typeof after.project !== "string" ||
      cursors.has(cursor)
    )
      throw new Error("周期代码项目依据分页游标无效")
    cursors.add(cursor)
  }
  return result
}
