import { describe, expect, it, vi } from "vitest"

// event-reporter 拉的是 electron / storage，这里只需要它导出的事件名常量能被解析。
vi.mock("../services/event-reporter", () => ({ trackEvent: () => undefined }))

const { MANAGED_RUN_STARTED_EVENT } = await import("../harness-board/managed-run-telemetry")
const {
  buildProjectModeManagedRunFilters,
  buildProjectModeManagedRunAggs,
  parseProjectModeManagedRunCount
} = await import("./project-mode-managed-run-metrics")

/**
 * 项目列表「托管运行次数」的聚合。
 *
 * 这一列和项目名旁边的「托管运行」标签是两条独立的路：标签来自快照上的单调标记，是终身
 * 事实；次数来自事件，受所选时间范围约束。所以「标签亮着、次数是 0」是合法状态，用例里
 * 要把这个口径钉住，免得以后有人觉得不一致顺手把它们并成一个。
 */

const TIME_RANGE = { range: { eventTime: { gte: "2026-09-01", lte: "2026-09-30" } } }

describe("托管运行次数的查询条件", () => {
  it("过滤上报出去的那个事件名，不是另写一个字符串", () => {
    // 写死字符串的话，上报侧改名这里不会报错，只会悄悄查不到数据。
    const filters = buildProjectModeManagedRunFilters(["p1"], TIME_RANGE)
    expect(filters[0]).toEqual({ term: { eventName: MANAGED_RUN_STARTED_EVENT } })
    expect(MANAGED_RUN_STARTED_EVENT).toBe("harness.managed_run.started")
  })

  it("带上时间范围，所以这一列跟着范围选择器走", () => {
    const filters = buildProjectModeManagedRunFilters(["p1", "p2"], TIME_RANGE)
    expect(filters).toContainEqual(TIME_RANGE)
    expect(filters).toContainEqual({ terms: { "properties.harnessProjectId": ["p1", "p2"] } })
  })

  it("附加过滤（组织维度）排在后面，不覆盖前面的条件", () => {
    const org = { term: { upperOrgLv1: "某部门" } }
    const filters = buildProjectModeManagedRunFilters(["p1"], TIME_RANGE, [org])
    expect(filters).toHaveLength(4)
    expect(filters[3]).toEqual(org)
  })

  it("按 managedRunId 去重，挡住重复投递", () => {
    const aggs = buildProjectModeManagedRunAggs(
      buildProjectModeManagedRunFilters(["p1"], TIME_RANGE)
    )
    expect(aggs).toHaveProperty("managed_runs")
    expect(JSON.stringify(aggs)).toContain('"properties.managedRunId"')
  })
})

describe("托管运行次数的取值", () => {
  it("优先用去重后的运行数", () => {
    // 同一次运行只发一条 started，正常情况下两个数字相等；不等说明有重复投递，
    // 这时候去重的那个才是真实次数。
    expect(
      parseProjectModeManagedRunCount({
        managed_runs: { doc_count: 9, distinct_runs: { value: 7 } }
      })
    ).toBe(7)
  })

  it("没有去重值时退回 doc_count", () => {
    expect(parseProjectModeManagedRunCount({ managed_runs: { doc_count: 4 } })).toBe(4)
  })

  it("桶不存在就是 0", () => {
    // 「这段时间没开过托管」和「没有这个桶」在这里是同一件事。
    expect(parseProjectModeManagedRunCount({})).toBe(0)
    expect(parseProjectModeManagedRunCount(undefined)).toBe(0)
    expect(parseProjectModeManagedRunCount({ managed_runs: {} })).toBe(0)
  })

  it("类型不对时当作 0，不把 NaN 抛到界面上", () => {
    expect(
      parseProjectModeManagedRunCount({ managed_runs: { distinct_runs: { value: "7" } } })
    ).toBe(0)
    expect(parseProjectModeManagedRunCount({ managed_runs: { doc_count: -1 } })).toBe(0)
  })
})
