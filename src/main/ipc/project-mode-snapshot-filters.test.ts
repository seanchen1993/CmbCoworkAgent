import { describe, expect, it } from "vitest"

import {
  HARNESS_PROJECT_SNAPSHOT_EVENT,
  PROJECT_MODE_CREATED_AT_FIELD,
  PROJECT_MODE_FROM_LEAN_FIELD,
  buildProjectModeCreatedAtRangeFilters,
  matchesProjectModeCreatedAtRange,
  projectModeNarrowingEnabled,
  projectModeSnapshotFilterArgs,
  projectModeSnapshotFilters
} from "./project-mode-snapshot-filters"

/**
 * 「仅本期新建」开关。
 *
 * 这个开关筛的是项目的诞生时间，不是项目在这段时间里干了什么——后者是列表每行那些
 * per-range 指标的事。两者容易被混成一个，用例里把区别钉住。
 *
 * 另一半是字典序前提：keyword mapping 下 range 能用，靠的是两端都是等宽 UTC ISO-8601。
 * 这个前提没有类型能保护，只能靠用例把它写成会挂的断言。
 */

const RANGE = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" }

describe("仅本期新建：ES 过滤条件", () => {
  it("开关关闭时不产生任何条件，列表回到全量", () => {
    expect(buildProjectModeCreatedAtRangeFilters(false, RANGE)).toEqual([])
  })

  it("开关打开时按创建时间字段出一条闭区间 range", () => {
    expect(buildProjectModeCreatedAtRangeFilters(true, RANGE)).toEqual([
      {
        range: {
          "properties.lifecycleCreatedAt": {
            gte: "2026-09-01T00:00:00.000Z",
            lte: "2026-09-30T23:59:59.999Z"
          }
        }
      }
    ])
  })

  it("筛的是创建时间，不是事件时间", () => {
    // 写错成 eventTime 的话语义完全变了（变成「这段时间有动静的项目」），
    // 而且两条查询都跑得通、都不报错，只能靠断言字段名挡住。
    const [filter] = buildProjectModeCreatedAtRangeFilters(true, RANGE)
    const field = Object.keys((filter as { range: Record<string, unknown> }).range)[0]
    expect(field).toBe(PROJECT_MODE_CREATED_AT_FIELD)
    expect(field).not.toBe("eventTime")
  })

  it("范围缺任一端时当开关没开，不发半个区间出去", () => {
    expect(buildProjectModeCreatedAtRangeFilters(true, null)).toEqual([])
    expect(buildProjectModeCreatedAtRangeFilters(true, { from: "", to: RANGE.to })).toEqual([])
    expect(buildProjectModeCreatedAtRangeFilters(true, { from: RANGE.from, to: "" })).toEqual([])
  })

  it("边界原样透传，不做取整或时区搬运", () => {
    // keyword mapping 下 ES 比的是原始字符串：这里一旦擅自把边界改写成日期粒度
    // （"2026-09-30"），当天带时分秒的项目会被整体漏掉。
    const [filter] = buildProjectModeCreatedAtRangeFilters(true, RANGE)
    const bounds = (filter as { range: Record<string, { gte: string; lte: string }> }).range[
      PROJECT_MODE_CREATED_AT_FIELD
    ]
    expect(bounds.gte).toBe(RANGE.from)
    expect(bounds.lte).toBe(RANGE.to)
    expect(bounds.lte).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("等宽 UTC ISO-8601 下字典序等于时间序，keyword mapping 才敢用 range", () => {
    // 这条不是测实现，是把「换时间格式就会静默筛错」这个前提摆在测试里。
    const inside = "2026-09-15T08:30:00.000Z"
    const before = "2026-08-31T23:59:59.999Z"
    const after = "2026-10-01T00:00:00.000Z"
    expect(before < RANGE.from).toBe(true)
    expect(inside >= RANGE.from && inside <= RANGE.to).toBe(true)
    expect(after > RANGE.to).toBe(true)
    // 换成带偏移量的本地时间，字典序立刻和时间序脱钩：下面这个时刻其实是
    // 2026-09-30T18:00Z，在范围内，但字符串以 "2026-10-01" 开头，字典序比上界大，
    // keyword mapping 下会被整条漏掉。所以上报侧不能把创建时间改成本地时间。
    const localTimeStyle = "2026-10-01T02:00:00.000+08:00"
    expect(Date.parse(localTimeStyle)).toBeLessThan(Date.parse(RANGE.to))
    expect(localTimeStyle <= RANGE.to).toBe(false)
  })
})

describe("仅本期新建：DEV mock 的同口径判断", () => {
  it("开关关闭时全部放行", () => {
    expect(matchesProjectModeCreatedAtRange(undefined, false, RANGE)).toBe(true)
    expect(matchesProjectModeCreatedAtRange("2020-01-01T00:00:00.000Z", false, RANGE)).toBe(true)
  })

  it("开关打开时只留下创建时间在范围内的", () => {
    expect(matchesProjectModeCreatedAtRange("2026-09-15T08:30:00.000Z", true, RANGE)).toBe(true)
    expect(matchesProjectModeCreatedAtRange("2026-08-31T23:59:59.999Z", true, RANGE)).toBe(false)
    expect(matchesProjectModeCreatedAtRange("2026-10-01T00:00:00.000Z", true, RANGE)).toBe(false)
  })

  it("两端闭区间，边界值算在范围内", () => {
    expect(matchesProjectModeCreatedAtRange(RANGE.from, true, RANGE)).toBe(true)
    expect(matchesProjectModeCreatedAtRange(RANGE.to, true, RANGE)).toBe(true)
  })

  it("创建时间缺失或解析不出来的一律不命中，对齐 ES 上缺字段不匹配 range 的行为", () => {
    expect(matchesProjectModeCreatedAtRange(undefined, true, RANGE)).toBe(false)
    expect(matchesProjectModeCreatedAtRange("", true, RANGE)).toBe(false)
    expect(matchesProjectModeCreatedAtRange("not-a-date", true, RANGE)).toBe(false)
  })

  it("范围本身不可用时放行，不把整张列表筛空", () => {
    expect(matchesProjectModeCreatedAtRange("2026-09-15T08:30:00.000Z", true, null)).toBe(true)
  })
})

/**
 * 接线本身也要测。条件写对了、但忘了拼进快照 filter 里，是这类开关最常见的失效方式：
 * 查询照跑、页面照显示，只是开关点了没反应。
 */
describe("快照 filter 组的接线", () => {
  const ORG = { term: { upperOrgLv1: "某部门" } }

  it("默认只有快照事件这一条，不带任何开关", () => {
    expect(projectModeSnapshotFilters(null)).toEqual([
      { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } }
    ])
    expect(HARNESS_PROJECT_SNAPSHOT_EVENT).toBe("harness.project.snapshot")
  })

  it("「仅本期新建」打开时，创建时间条件确实拼进了 filter 组", () => {
    const filters = projectModeSnapshotFilters(null, false, true, RANGE)
    expect(filters).toContainEqual(buildProjectModeCreatedAtRangeFilters(true, RANGE)[0])
  })

  it("开关关闭时不往 filter 组里塞创建时间条件", () => {
    const filters = projectModeSnapshotFilters(null, false, false, RANGE)
    expect(JSON.stringify(filters)).not.toContain(PROJECT_MODE_CREATED_AT_FIELD)
  })

  it("给了范围但开关没开，也不能筛——范围是每次都传的，开关才是意图", () => {
    // 调用点统一把 range 传下来，所以「传了 range」不等于「要按 range 筛」。
    expect(projectModeSnapshotFilters(ORG, false, false, RANGE)).toEqual([
      { term: { eventName: HARNESS_PROJECT_SNAPSHOT_EVENT } },
      ORG
    ])
  })

  it("两个开关互相独立，可以叠加", () => {
    const both = projectModeSnapshotFilters(ORG, true, true, RANGE)
    expect(both).toContainEqual({ term: { [PROJECT_MODE_FROM_LEAN_FIELD]: true } })
    expect(both).toContainEqual(buildProjectModeCreatedAtRangeFilters(true, RANGE)[0])
    // 只开精益时不该顺带把创建时间也筛了。
    const leanOnly = projectModeSnapshotFilters(ORG, true, false, RANGE)
    expect(leanOnly).toContainEqual({ term: { [PROJECT_MODE_FROM_LEAN_FIELD]: true } })
    expect(JSON.stringify(leanOnly)).not.toContain(PROJECT_MODE_CREATED_AT_FIELD)
  })

  it("组织筛选和开关不互相覆盖", () => {
    const filters = projectModeSnapshotFilters(ORG, true, true, RANGE)
    expect(filters).toHaveLength(4)
    expect(filters[1]).toEqual(ORG)
  })
})

/**
 * 调用点读 opts 的那一层。六个调用点全都展开 projectModeSnapshotFilterArgs，所以这里
 * 漏掉一个开关，六处会一起漏——反过来说，测住这里就等于测住了六处的口径一致。
 */
describe("从 opts 取开关", () => {
  it("把两个开关和范围按顺序摊平，范围原样透传", () => {
    expect(projectModeSnapshotFilterArgs({ createdInRangeOnly: true }, RANGE)).toEqual([
      false,
      true,
      RANGE
    ])
    expect(projectModeSnapshotFilterArgs({ fromLeanOnly: true }, RANGE)).toEqual([
      true,
      false,
      RANGE
    ])
  })

  it("只认 true，null / undefined 都当没开", () => {
    // IPC 过来的是 boolean | null，写成 Boolean(x) 会把 null 也当 false（碰巧对），
    // 但写成 x != null 就错了，所以把 === true 的语义钉住。
    expect(projectModeSnapshotFilterArgs(undefined, RANGE)).toEqual([false, false, RANGE])
    expect(
      projectModeSnapshotFilterArgs({ fromLeanOnly: null, createdInRangeOnly: null }, RANGE)
    ).toEqual([false, false, RANGE])
  })

  it("任一开关打开都要去解析项目 id 集，否则遥测汇总圈不住", () => {
    expect(projectModeNarrowingEnabled(undefined)).toBe(false)
    expect(projectModeNarrowingEnabled({})).toBe(false)
    expect(projectModeNarrowingEnabled({ fromLeanOnly: true })).toBe(true)
    // 这一条是新开关最容易被漏掉的地方：只判精益的话，「仅本期新建」下汇总仍是全量。
    expect(projectModeNarrowingEnabled({ createdInRangeOnly: true })).toBe(true)
    expect(projectModeNarrowingEnabled({ fromLeanOnly: true, createdInRangeOnly: true })).toBe(true)
  })
})
