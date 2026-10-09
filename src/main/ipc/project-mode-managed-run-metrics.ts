import { MANAGED_RUN_STARTED_EVENT } from "../harness-board/managed-run-telemetry"

/**
 * 项目列表的「托管运行次数」。
 *
 * 这一列和「托管运行」标签是两条不同的路，故意的，和系统约束那对儿完全同构：
 *
 *   标签  ← 快照上的单调标记，终身事实，不受时间范围影响，能回填
 *   次数  ← harness.managed_run.started 按 eventTime 聚合，受时间范围影响
 *
 * 所以「标签亮着但次数是 0」是正常的，表示这个项目跑过托管，但不在当前选的时间范围内。
 * 「约束加载」标签和「系统约束有效读取次数」现在就是这个行为。
 *
 * 数的是开始而不是结束：一次开了还没结束的托管运行，也是一次真实发生过的托管运行。
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 与约束读取、hook 同一套过滤形状，好让它们能并到同一次查询里。 */
export function buildProjectModeManagedRunFilters(
  scopedProjectIds: string[],
  timeRangeClause: Record<string, unknown>,
  extraFilters: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  return [
    { term: { eventName: MANAGED_RUN_STARTED_EVENT } },
    timeRangeClause,
    { terms: { "properties.harnessProjectId": scopedProjectIds } },
    ...extraFilters
  ]
}

export function buildProjectModeManagedRunAggs(
  managedRunFilters: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    managed_runs: {
      filter: { bool: { filter: managedRunFilters } },
      aggs: {
        // 同一次托管运行只会发一条 started，所以 doc_count 就够。留这个 cardinality
        // 是为了万一将来出现重放或重复投递，两个数字对不上时能看出来。
        distinct_runs: { cardinality: { field: "properties.managedRunId" } }
      }
    }
  }
}

/**
 * 取运行次数。优先用去重后的运行数，它对重复投递免疫；桶不存在时返回 0，因为「这个
 * 项目在这段时间没开过托管」和「没数据」在这里是同一回事。
 */
export function parseProjectModeManagedRunCount(bucket: unknown): number {
  const managedRuns = asRecord(asRecord(bucket).managed_runs)
  const distinct = asRecord(managedRuns.distinct_runs).value
  if (typeof distinct === "number" && Number.isFinite(distinct) && distinct >= 0) {
    return distinct
  }
  const docCount = managedRuns.doc_count
  return typeof docCount === "number" && Number.isFinite(docCount) && docCount >= 0 ? docCount : 0
}
