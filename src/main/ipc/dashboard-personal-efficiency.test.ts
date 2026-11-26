import { afterEach, describe, expect, it, vi } from "vitest"
import * as projectMetrics from "./dashboard-project-metrics"
import {
  assemblePersonalEfficiency,
  fetchPersonalEfficiencyCode,
  fetchPersonalEfficiency,
  aggregatePersonalMonthlyRecords
} from "./dashboard-personal-efficiency"
import { makeMockProjectMetricProjects } from "./dashboard-project-metrics"
import {
  defaultPersonalEfficiencyWeights,
  type PersonalEfficiencyCodeRow
} from "../../shared/personal-efficiency"
import { rankPersonalEfficiency } from "../../shared/personal-efficiency-ranking"
import type { ProjectMetricProjectItem } from "../../shared/project-metrics"

function project(
  prjCode: string,
  extra: Partial<ProjectMetricProjectItem> = {}
): ProjectMetricProjectItem {
  const sample = makeMockProjectMetricProjects(
    { range: { from: "2026-10-01", to: "2026-10-31" } },
    { exportAll: true }
  ).items[0]
  return {
    ...sample,
    prjCode,
    pm: "甲/8001",
    featureCodes: ["F1"],
    notAdjustFuns: 100,
    bugNum: 2,
    kenanIssueCount: 0,
    approvalDevelopmentDays: 4,
    ...extra
  }
}
function code(
  sapId: string,
  extra: Partial<PersonalEfficiencyCodeRow> = {}
): PersonalEfficiencyCodeRow {
  return {
    sapId,
    userName: "代码作者",
    harnessProjectId: "h1",
    prjCode: "P1",
    roomName: "A室",
    pushedAdoptedLines: 60,
    pushedEffectiveGeneratedLines: 100,
    ...extra
  }
}

describe("个人效能项目与本人代码关联", () => {
  it("项目按 PM 的 sapId 归属，跨项目特性去重，密度使用合计分子分母", () => {
    const { people } = assemblePersonalEfficiency(
      [
        project("P1"),
        project("P2", {
          featureCodes: ["F1", "F2"],
          notAdjustFuns: 300,
          bugNum: 3,
          approvalDevelopmentDays: 8
        }),
        project("P3", { pm: "甲/8002" })
      ],
      [code("8001"), code("8003")],
      [],
      null
    )
    expect(people.map((person) => person.sapId)).toEqual(["8001", "8002", "8003"])
    expect(people[0].values).toMatchObject({
      featureCount: 2,
      functionPoints: 400,
      bugCount: 5,
      defectDensity: 1.25,
      issueCount: 0,
      approvalDevelopmentDays: 6,
      adoptionRate: 60
    })
    expect(people[0].durationProjectCount).toBe(2)
    expect(people[2].values.featureCount).toBeNull()
    expect(people[2].values.adoptionRate).toBe(60)
  })
  it("本人入库率按分子分母合计，不平均项目比例，不使用 PM 项目的全部代码", () => {
    const { people } = assemblePersonalEfficiency(
      [project("P1")],
      [
        code("8002"),
        code("8002", {
          harnessProjectId: "h2",
          pushedAdoptedLines: 30,
          pushedEffectiveGeneratedLines: 300
        })
      ],
      [],
      null
    )
    expect(people[0].values.adoptionRate).toBeNull()
    expect(people[1].values.adoptionRate).toBe(22.5)
    expect(people[1].projectCount).toBe(0)
  })
  it("同一精益项目的多个Harness明细分行不改变个人指标、月度累计或排名", () => {
    const first = code("8001", { pushedAdoptedLines: 60, pushedEffectiveGeneratedLines: 100 })
    const second = code("8001", {
      harnessProjectId: "h2",
      pushedAdoptedLines: 30,
      pushedEffectiveGeneratedLines: 300
    })
    const monthly = [
      {
        sapId: "8001",
        devagentIdePushedLines: 100,
        devagentCliPushedLines: 10,
        totalPushedLines: 1000
      }
    ]
    const split = assemblePersonalEfficiency(
      [project("P1")],
      [first, second],
      monthly,
      "2026-10"
    ).people
    const merged = assemblePersonalEfficiency(
      [project("P1")],
      [{ ...first, pushedAdoptedLines: 90, pushedEffectiveGeneratedLines: 400 }],
      monthly,
      "2026-10"
    ).people
    expect(split[0].code.map((row) => row.prjCode)).toEqual(["P1", "P1"])
    expect(split[0].values).toEqual(merged[0].values)
    expect(split[0].values).toMatchObject({
      adoptionRate: 22.5,
      devclawPushedLines: 90,
      aiPushedLines: 200,
      aiPushRate: 20,
      featureCount: 1
    })
    expect(split[0].projectCount).toBe(1)
    expect(
      rankPersonalEfficiency(split, defaultPersonalEfficiencyWeights()).map(({ score, rank }) => ({
        score,
        rank
      }))
    ).toEqual(
      rankPersonalEfficiency(merged, defaultPersonalEfficiencyWeights()).map(({ score, rank }) => ({
        score,
        rank
      }))
    )
  })
  it("缺失 PM 不按姓名猜测身份；缺失字段不当作零；耗时与密度只选有效项目", () => {
    const { people, missingPmCount } = assemblePersonalEfficiency(
      [
        project("P1"),
        project("P2", { bugNum: null, notAdjustFuns: null, approvalDevelopmentDays: null }),
        project("P3", { pm: "仅姓名" })
      ],
      null,
      [],
      null
    )
    expect(missingPmCount).toBe(1)
    expect(people[0].values).toMatchObject({
      bugCount: null,
      functionPoints: null,
      defectDensity: 2,
      approvalDevelopmentDays: 4,
      adoptionRate: null
    })
    expect(people[0].pushedAdoptedLines).toBeNull()
  })
  it("自然月只合计 IDE、CLI、DevClaw，全部 Push 为分母；组织记录或其他人员不创建排名人员", () => {
    const { people } = assemblePersonalEfficiency(
      [],
      [code("8001")],
      [
        {
          sapId: "8001",
          devagentIdePushedLines: 100,
          devagentCliPushedLines: 40,
          totalPushedLines: 1000
        },
        { sapId: "8004", devagentIdePushedLines: 1, devagentCliPushedLines: 1, totalPushedLines: 5 }
      ],
      "2026-10"
    )
    expect(people).toHaveLength(1)
    expect(people[0].values).toMatchObject({
      devclawPushedLines: 60,
      aiPushedLines: 200,
      aiPushRate: 20,
      idePushRate: 10,
      cliPushRate: 4,
      devclawPushRate: 6,
      totalPushedLines: 1000
    })
  })
  it("渠道缺失不产生累计值，零渠道有效，零分母不产生比例，非自然月无月度值", () => {
    const input = [{ sapId: "8001", devagentIdePushedLines: 0, totalPushedLines: 0 }]
    expect(
      assemblePersonalEfficiency([], [code("8001")], input, "2026-10").people[0].values
    ).toMatchObject({
      idePushedLines: 0,
      cliPushedLines: null,
      aiPushedLines: null,
      aiPushRate: null
    })
    expect(
      assemblePersonalEfficiency([], [code("8001")], input, null).people[0].values.totalPushedLines
    ).toBeNull()
    expect(() => assemblePersonalEfficiency([], [], [...input, ...input], "2026-10")).toThrow(
      "重复"
    )
  })
})

describe("个人连续完整自然月累计", () => {
  const months = ["2026-07", "2026-08", "2026-09"]
  const records = months.map((timeRange, index) => ({
    sapId: "8001",
    timeRange,
    devagentIdePushedLines: (index + 1) * 10,
    devagentCliPushedLines: index + 1,
    totalPushedLines: (index + 1) * 100
  }))
  it("三季度按月份相加各来源和总Push，DevClaw直接使用整周期遥测", () => {
    const monthly = aggregatePersonalMonthlyRecords(months, records)
    const person = assemblePersonalEfficiency([], [code("8001")], monthly, "2026-07 至 2026-09")
      .people[0]
    expect(person.values).toMatchObject({
      idePushedLines: 60,
      cliPushedLines: 6,
      totalPushedLines: 600,
      devclawPushedLines: 60,
      aiPushedLines: 126,
      aiPushRate: 21
    })
  })
  it("缺少任一月份时累计不可用，缺单个渠道字段只影响该渠道及依赖指标", () => {
    const missingMonth = aggregatePersonalMonthlyRecords(months, [records[0], records[2]])
    expect(missingMonth[0]).toMatchObject({
      devagentIdePushedLines: null,
      devagentCliPushedLines: null,
      totalPushedLines: null
    })
    const missingCli = aggregatePersonalMonthlyRecords(months, [
      records[0],
      records[1],
      { ...records[2], devagentCliPushedLines: null }
    ])
    expect(missingCli[0]).toMatchObject({
      devagentIdePushedLines: 60,
      devagentCliPushedLines: null,
      totalPushedLines: 600
    })
    const values = assemblePersonalEfficiency([], [code("8001")], missingCli, "2026-07 至 2026-09")
      .people[0].values
    expect(values).toMatchObject({
      idePushedLines: 60,
      cliPushedLines: null,
      devclawPushedLines: 60,
      aiPushedLines: null,
      aiPushRate: null
    })
  })
  it("允许同一人员多个月份，拒绝同一人员同月重复记录，真实零参与累计", () => {
    expect(aggregatePersonalMonthlyRecords(months, records)).toHaveLength(1)
    expect(() => aggregatePersonalMonthlyRecords(months, [...records, records[0]])).toThrow(
      "同月存在重复"
    )
    expect(
      aggregatePersonalMonthlyRecords(
        months,
        records.map((row) => ({ ...row, devagentIdePushedLines: 0 }))
      )[0].devagentIdePushedLines
    ).toBe(0)
  })
})

describe("个人代码完整分页", () => {
  it("保留人员和项目聚合条件，并完整遍历复合游标", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        aggregations: {
          people: {
            buckets: [
              {
                key: { sapId: "8001", project: "h1", room: "A室" },
                code_adopt_pushed: {},
                latest: { hits: { hits: [{ _source: { userName: "甲" } }] } }
              }
            ],
            after_key: { sapId: "8001", project: "h1", room: "A室" }
          }
        }
      })
      .mockResolvedValueOnce({ aggregations: { people: { buckets: [] } } })
    const filters = [{ term: { upperOrgLv1: "A室" } }]
    const result = await fetchPersonalEfficiencyCode(query, "event", filters, {
      code_adopt_pushed: { filter: {} }
    })
    expect(result[0]).toMatchObject({ sapId: "8001", userName: "甲", harnessProjectId: "h1" })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0][1].query.bool.filter).toEqual(filters)
    expect(query.mock.calls[1][1].aggs.people.composite.after).toEqual({
      sapId: "8001",
      project: "h1",
      room: "A室"
    })
  })
  it("分片失败、缺少人员或聚合时拒绝不完整排名", async () => {
    for (const response of [
      { timed_out: true },
      { _shards: { failed: 1 } },
      { aggregations: { people: { buckets: [{ key: { project: "h1" } }] } } },
      {}
    ]) {
      await expect(
        fetchPersonalEfficiencyCode(vi.fn().mockResolvedValue(response), "event", [], {})
      ).rejects.toThrow()
    }
  })
})

afterEach(() => vi.restoreAllMocks())

describe("个人查询权限和失败隔离", () => {
  const filters = { range: { from: "2026-10-01", to: "2026-10-31" }, upperOrgLv1: ["A室", "B室"] }
  function context() {
    vi.spyOn(projectMetrics, "fetchPersonalEfficiencyProjectContext").mockResolvedValue({
      projects: [project("P1")],
      bindings: [{ harnessProjectId: "h1", prjCode: "P1", adapterName: "" }],
      warnings: []
    })
  }
  function deps(query = vi.fn().mockResolvedValue({ aggregations: { people: { buckets: [] } } })) {
    return {
      query,
      eventIndex: "event",
      traceIndex: "trace",
      factIndex: "fact",
      monthlyIndex: "monthly",
      allowedRoomNames: ["A室"]
    }
  }
  it("月度及代码范围取所选室和权限室交集，不使用 PM 组织", async () => {
    context()
    const dependencies = deps()
    const codeQuery = vi.fn().mockResolvedValue([code("8001")])
    await fetchPersonalEfficiency(filters, dependencies, codeQuery)
    expect(codeQuery).toHaveBeenCalledWith(["h1"], ["A室"])
    expect(dependencies.query.mock.calls[0][1].query.bool.filter).toContainEqual({
      terms: { roomName: ["A室"] }
    })
    expect(dependencies.query.mock.calls[0][1].query.bool.filter).toContainEqual({
      term: { orgLevel: "user" }
    })
    expect(dependencies.query.mock.calls[0][1].query.bool.filter).toContainEqual({
      terms: { timeRange: ["2026-10"] }
    })
  })
  it("非自然月不查询月度；代码读取失败仍保留 PM 项目并明确提示", async () => {
    context()
    const dependencies = deps()
    const result = await fetchPersonalEfficiency(
      { ...filters, range: { from: "2026-10-03", to: "2026-10-31" } },
      dependencies,
      vi.fn().mockRejectedValue(new Error("代码连接失败"))
    )
    expect(dependencies.query).not.toHaveBeenCalled()
    expect(result.people[0].projectCount).toBe(1)
    expect(result.people[0].values.adoptionRate).toBeNull()
    expect(result.warnings.join()).toContain("代码连接失败")
  })
  it("三季度按人员及月份分页读取并累计，包含不完整10月则整体隐藏月度指标", async () => {
    context()
    const records = ["2026-07", "2026-08", "2026-09"].map((timeRange, index) => ({
      sapId: "8001",
      timeRange,
      devagentIdePushedLines: 10 * (index + 1),
      devagentCliPushedLines: index + 1,
      totalPushedLines: 100 * (index + 1)
    }))
    const query = vi.fn().mockResolvedValue({
      aggregations: {
        people: {
          buckets: records.map((row) => ({
            doc_count: 1,
            key: { sapId: row.sapId, month: row.timeRange },
            latest: { hits: { hits: [{ _source: row }] } }
          }))
        }
      }
    })
    const dependencies = deps(query)
    const codeQuery = vi.fn().mockResolvedValue([code("8001")])
    const result = await fetchPersonalEfficiency(
      { ...filters, range: { from: "2026-07-01", to: "2026-09-30" } },
      dependencies,
      codeQuery
    )
    expect(result.month).toBe("2026-07 至 2026-09")
    expect(result.people[0].values).toMatchObject({ aiPushedLines: 126, aiPushRate: 21 })
    expect(query.mock.calls[0][1].query.bool.filter).toContainEqual({
      terms: { timeRange: ["2026-07", "2026-08", "2026-09"] }
    })
    expect(query.mock.calls[0][1].aggs.people.composite.sources).toContainEqual({
      month: { terms: { field: "timeRange" } }
    })
    query.mockClear()
    const partial = await fetchPersonalEfficiency(
      { ...filters, range: { from: "2026-07-01", to: "2026-10-20" } },
      dependencies,
      codeQuery
    )
    expect(partial.month).toBeNull()
    expect(partial.people[0].values.idePushedLines).toBeNull()
    expect(query).not.toHaveBeenCalled()
  })
  it("单人详情跳过月度查询，透传人员范围以读取本人项目明细", async () => {
    context()
    const dependencies = deps()
    const codeQuery = vi.fn().mockResolvedValue([code("8001")])
    const result = await fetchPersonalEfficiency(filters, dependencies, codeQuery, "8001")
    expect(dependencies.query).not.toHaveBeenCalled()
    expect(projectMetrics.fetchPersonalEfficiencyProjectContext).toHaveBeenCalledWith(
      filters,
      dependencies,
      "8001",
      false
    )
    expect(result.people[0].code[0].prjCode).toBe("P1")
  })
  it("月度重复记录只使月度不可用，个人代码及项目指标不丢失", async () => {
    context()
    const query = vi
      .fn()
      .mockResolvedValue({ aggregations: { people: { buckets: [{ doc_count: 2 }] } } })
    const result = await fetchPersonalEfficiency(
      filters,
      deps(query),
      vi.fn().mockResolvedValue([code("8001")])
    )
    expect(result.people[0].values.adoptionRate).toBe(60)
    expect(result.people[0].values.aiPushRate).toBeNull()
    expect(result.warnings.join()).toContain("重复")
  })
})
