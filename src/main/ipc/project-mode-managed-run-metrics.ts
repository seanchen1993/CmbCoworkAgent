import { MANAGED_RUN_STARTED_EVENT } from "../harness-board/managed-run-telemetry"

/** 项目累计托管运行次数；传入时间条件时兼容旧调用方的区间统计。 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 与约束读取、hook 同一套过滤形状，好让它们能并到同一次查询里。 */
export function buildProjectModeManagedRunFilters(
  scopedProjectIds: string[],
  timeRangeClause: Record<string, unknown> | null,
  extraFilters: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  return [
    { term: { eventName: MANAGED_RUN_STARTED_EVENT } },
    ...(timeRangeClause ? [timeRangeClause] : []),
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
