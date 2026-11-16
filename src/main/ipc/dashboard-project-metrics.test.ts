import { beforeEach, describe, expect, it, vi } from "vitest"
import * as XLSX from "xlsx"
import { PROJECT_METRIC_TEAM, type ProjectMetricFilters } from "../../shared/project-metrics"
import { projectMetricIndicatorSheets } from "../../renderer/src/components/dashboard/panels/project-metric-indicator-export"
import {
  fetchProjectMetricIndicatorExport,
  fetchProjectMetricOverview,
  fetchProjectMetricProjects,
  fetchProjectMetricSummary,
  fetchProjectMetricTrend,
  makeMockProjectMetricOverview,
  type ProjectMetricDependencies
} from "./dashboard-project-metrics"

type Doc = Record<string, unknown>
function field(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Doc)?.[key], doc)
}
function match(doc: Doc, clause: unknown): boolean {
  const c = clause as Doc
  if (!c) return true
  if (c.match_none) return false
  if (c.bool) {
    const b = c.bool as Doc
    const list = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
    return (
      list(b.filter).every((x) => match(doc, x)) &&
      !list(b.must_not).some((x) => match(doc, x)) &&
      (!b.should ||
        list(b.should).filter((x) => match(doc, x)).length >= Number(b.minimum_should_match ?? 1))
    )
  }
  for (const [kind, values] of Object.entries(c))
    for (const [key, value] of Object.entries(values as Doc)) {
      const actual = field(doc, key)
      if (kind === "term" && actual !== value) return false
      if (
        kind === "terms" &&
        !(Array.isArray(actual) ? actual : [actual]).some((v) => (value as unknown[]).includes(v))
      )
        return false
      if (
        kind === "exists" &&
        (field(doc, String(value)) == null || field(doc, String(value)) === "")
      )
        return false
      if (kind === "range") {
        if (actual == null) return false
        const a = String(actual).padEnd(19, " 00:00:00")
        const v = value as Doc
        if ((v.gte && a < String(v.gte)) || (v.lt && a >= String(v.lt))) return false
      }
    }
  return true
}
const october: ProjectMetricFilters = { range: { from: "2026-10-01", to: "2026-10-31" } }
function project(code: string, extra: Doc = {}): Doc {
  return {
    prjCode: code,
    prjName: code,
    teamName: PROJECT_METRIC_TEAM,
    roomName: "A室",
    createDate: "2026-10-12 00:00:00",
    firstStStartDate: "2026-10-19 09:15:47",
    firstOnlineDate: "2026-10-14 00:00:00",
    approvedDate: "2026-10-09 17:29:27",
    devWorkHours: 217,
    notAdjustFuns: 214.72,
    bugNum: 2,
    kenanIssueCount: 0,
    featureCodes: ["F1"],
    ...extra
  }
}
function harness(code: string, id = `h-${code}`, flags: Doc = {}): Doc {
  return {
    eventName: "harness.project.snapshot",
    properties: {
      projectCode: code,
      projectId: id,
      projectFromLean: true,
      adapterName: "plugin",
      ...flags
    }
  }
}
function fixture({
  projects = [project("P1")],
  snapshots = [harness("P1")],
  monthly = [] as Doc[],
  codeError = false,
  tokenError = false,
  nameError = false
} = {}) {
  const queries: Array<{ index: string; body: Doc }> = []
  const query = vi.fn(async (index: string, body: Doc): Promise<unknown> => {
    queries.push({ index, body })
    const aggs = body.aggs as Doc | undefined
    if (index === "events" && aggs?.projects && (aggs.projects as Doc).composite) {
      const agg = aggs.projects as { composite: { after?: { projectId: string }; size: number } }
      const filtered = snapshots
        .filter((s) => match(s, body.query))
        .sort((a, b) =>
          String(field(a, "properties.projectId")).localeCompare(
            String(field(b, "properties.projectId"))
          )
        )
      const after = agg.composite.after?.projectId
      const all = filtered.filter((s) => !after || String(field(s, "properties.projectId")) > after)
      const page = all.slice(0, agg.composite.size)
      const isTestLookup = !(aggs.projects as Doc).aggs
      return {
        aggregations: {
          projects: {
            buckets: page.map((s) => ({
              key: { projectId: field(s, "properties.projectId") },
              ...(isTestLookup ? {} : { snapshot: { hits: { hits: [{ _source: s }] } } })
            })),
            ...(all.length > page.length
              ? { after_key: { projectId: field(page[page.length - 1], "properties.projectId") } }
              : {})
          }
        }
      }
    }
    if (index === "traces" && aggs?.rooms) return { aggregations: { rooms: { buckets: [] } } }
    if (index === "events" || index === "traces") {
      if ((index === "events" && codeError) || (index === "traces" && tokenError))
        throw new Error("遥测服务失败")
      return { aggregations: { projects: { buckets: [], sum_other_doc_count: 0 } } }
    }
    if (index === "features" && nameError) throw new Error("名称查询失败")
    const documents =
      index === "projects"
        ? projects
        : index === "monthly"
          ? monthly
          : [{ featureCode: "F1", featureName: "产品需求一" }]
    const filtered = documents
      .filter((p) => match(p, body.query))
      .sort((a, b) =>
        String(a.prjCode ?? a.featureCode).localeCompare(String(b.prjCode ?? b.featureCode))
      )
    const cursor = (body.search_after as string[] | undefined)?.[0]
    const all = filtered.filter((p) => !cursor || String(p.prjCode ?? p.featureCode) > cursor)
    const page = all.slice(0, Number(body.size))
    return {
      hits: {
        total: { value: filtered.length, relation: "eq" },
        hits: page.map((p) => ({ _source: p, sort: [p.prjCode ?? p.featureCode] }))
      }
    }
  })
  const codeStats = vi.fn(async () => ({
    pushedAdoptedLines: 100,
    pushedEffectiveGeneratedLines: 200,
    pushedAdoptionRate: 0.5
  }))
  const deps: ProjectMetricDependencies = {
    query,
    codeStats,
    eventIndex: "events",
    traceIndex: "traces",
    factIndex: "projects",
    featureIndex: "features",
    monthlyIndex: "monthly",
    allowedRoomNames: null
  }
  return { deps, queries, query, codeStats }
}
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("研发效能统一项目口径", () => {
  it("多特性项目工时只加一次；汇总分子分母，保留原有缺陷、类别和累计遥测指标", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", {
          featureCodes: ["F1", "F1", "F2"],
          kenanIssueCount: 3,
          kenanIssueCategoryCount: [{ category: "安全", count: 2 }]
        }),
        project("P2", { devWorkHours: 152.25, notAdjustFuns: 100 })
      ],
      snapshots: [harness("P1"), harness("P2")]
    })
    const { groups } = await fetchProjectMetricSummary(october, deps)
    expect(groups[0]).toMatchObject({
      projectCount: 2,
      productivityWorkHours: 369.25,
      productivityFunctionPoints: 314.72,
      throughputFeatureCount: 2,
      throughputWorkHours: 369.25,
      avgBugCount: 2,
      avgKenanIssueCount: 1.5,
      kenanIssueCategories: [{ category: "安全", count: 2 }],
      avgInputTokens: 0,
      avgPushedAdoptedLines: 0
    })
    expect(groups[0].functionPointsPerPersonMonth).toBeCloseTo((314.72 * 152.25) / 369.25)
    expect(groups[0].featuresPerPersonMonth).toBeCloseTo((2 * 152.25) / 369.25)
  })
  it("ST优先不比较早晚；开发完成和耗时终点一致；上线吞吐独立选样本", async () => {
    const { deps, queries } = fixture({
      projects: [project("P1", { firstUatStartDate: "2026-10-14 11:33:19" })]
    })
    const filters = { range: { from: "2026-10-14", to: "2026-10-18" } }
    const summary = await fetchProjectMetricSummary(filters, deps)
    expect(summary.groups[0].projectCount).toBe(0)
    expect(summary.groups[0].throughputFeatureCount).toBe(1)
    const detail = await fetchProjectMetricProjects(october, {}, deps)
    expect(detail.items[0]).toMatchObject({
      approvalDevelopmentDays: expect.any(Number),
      features: [{ featureCode: "F1", featureName: "产品需求一" }]
    })
    const { projectWorkingDays } = await import("../../shared/project-metric-calendar")
    expect(detail.items[0].approvalDevelopmentDays).toBe(
      projectWorkingDays("2026-10-09 17:29:27", "2026-10-19 09:15:47")
    )
    expect(JSON.stringify(queries.find((q) => q.index === "projects")?.body.query)).toContain(
      '"must_not":[{"exists":{"field":"firstStStartDate"}}]'
    )
  })
  it("趋势复用相同样本规则，吞吐按上线月份，其他指标按开发完成月份", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-16T00:00:00Z"))
    try {
      const { deps } = fixture({
        projects: [
          project("P1", {
            firstStStartDate: "2026-10-19 09:15:47",
            firstOnlineDate: "2026-09-14 00:00:00",
            featureCodes: ["F1", "F2"]
          }),
          project("P2", {
            firstStStartDate: "2026-09-19 09:15:47",
            firstOnlineDate: "2026-10-14 00:00:00",
            featureCodes: ["F3"]
          })
        ],
        snapshots: [harness("P1"), harness("P2")]
      })
      const trend = await fetchProjectMetricTrend({}, deps)
      expect(trend.months).toHaveLength(6)
      const october = trend.months.find((m) => m.month === "2026-10")?.groups[0]
      expect(october).toMatchObject({
        projectCount: 1,
        throughputFeatureCount: 1,
        productivityFunctionPoints: 214.72,
        throughputWorkHours: 217
      })
      const september = trend.months.find((m) => m.month === "2026-09")?.groups[0]
      expect(september).toMatchObject({ projectCount: 1, throughputFeatureCount: 2 })
    } finally {
      now.mockRestore()
    }
  })
  it("ST缺失回退UAT，既不要求上线也不把缺工时补零", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", {
          firstStStartDate: null,
          firstUatStartDate: "2026-10-14 11:33:19",
          firstOnlineDate: null
        }),
        project("P2", { devWorkHours: null }),
        project("P3", { devWorkHours: 0, notAdjustFuns: 0 })
      ],
      snapshots: [harness("P1"), harness("P2"), harness("P3")]
    })
    const result = await fetchProjectMetricSummary(october, deps)
    expect(result.groups[0]).toMatchObject({
      projectCount: 3,
      productivityWorkHours: 217,
      samples: { productivity: 2, throughput: 1 }
    })
    const detail = await fetchProjectMetricProjects(october, {}, deps)
    expect(detail.items.find((p) => p.prjCode === "P2")?.devWorkHours).toBeNull()
    expect(detail.items.find((p) => p.prjCode === "P3")?.devWorkHours).toBe(0)
  })
  it("两个测试标记均排除；同企业项目正常关联仍有效，报工不跨组重复", async () => {
    const { deps, codeStats } = fixture({
      projects: [project("P1"), project("P2"), project("P3")],
      snapshots: [
        harness("P1", "bad-1", { isTestProject: true }),
        harness("P2", "bad-2", { manuallyMarkedTestProject: true }),
        harness("P2", "good-2"),
        harness("P3", "not-lean", { projectFromLean: false })
      ]
    })
    const result = await fetchProjectMetricSummary(october, deps)
    expect(result.groups.map((g) => g.projectCount)).toEqual([1, 2])
    expect(result.groups.map((g) => g.throughputFeatureCount)).toEqual([1, 1])
    expect(result.groups.map((g) => g.throughputWorkHours)).toEqual([217, 434])
    await fetchProjectMetricOverview(october, deps)
    expect(codeStats).toHaveBeenCalledWith(october.range, null, ["good-2"])
  })
  it("常规侧不受插件和Token区间影响，单指标缺失不删除其他有效样本", async () => {
    const { deps } = fixture({
      projects: [project("P1"), project("P2", { notAdjustFuns: null, bugNum: 0 })]
    })
    const result = await fetchProjectMetricSummary(
      { ...october, adapterName: "other", tokenConsumptionMin: 1 },
      deps
    )
    expect(result.groups[0].projectCount).toBe(0)
    expect(result.groups[1]).toMatchObject({
      projectCount: 1,
      avgBugCount: 0,
      avgFuncPointCount: null
    })
    await expect(
      fetchProjectMetricProjects(
        { ...october, adapterName: "plugin" },
        { developmentMode: "non_devclaw" },
        deps
      )
    ).rejects.toThrow("常规项目")
  })
  it("名称失败仍返回编号；遥测失败不伪装零，Token筛选遇失败明确报错", async () => {
    const { deps } = fixture({ codeError: true, tokenError: true, nameError: true })
    const result = await fetchProjectMetricProjects(october, {}, deps)
    expect(result.items[0]).toMatchObject({
      pushedAdoptedLines: null,
      totalInputTokens: null,
      features: [{ featureCode: "F1", featureName: null }],
      bugNum: 2
    })
    expect(result.warnings.join(" ")).toContain("名称暂不可用")
    await expect(
      fetchProjectMetricSummary({ ...october, tokenConsumptionMin: 1 }, deps)
    ).rejects.toThrow("遥测服务失败")
  })
  it("复用快照关联时仍重新排除最新测试标记", async () => {
    const snapshots = [harness("P1")]
    const { deps } = fixture({ snapshots })
    expect((await fetchProjectMetricSummary(october, deps)).groups[0].projectCount).toBe(1)
    ;(snapshots[0].properties as Doc).manuallyMarkedTestProject = true
    expect(
      (await fetchProjectMetricSummary(october, deps)).groups.map((g) => g.projectCount)
    ).toEqual([0, 1])
  })
  it("mapping 不完整时不把缺少可查询关联误判成非智能化", async () => {
    const { deps } = fixture()
    deps.validateFactFields = async () => {
      throw new Error("featureCodes 未建立索引")
    }
    await expect(fetchProjectMetricSummary(october, deps)).rejects.toThrow("未建立索引")
    const result = await fetchProjectMetricOverview(october, deps)
    expect(result.features).toBeNull()
    expect(result.featureError).toContain("未建立索引")
    expect(result.code?.pushedAdoptionRate).toBe(0.5)
  })
  it("按室强制收敛权限，固定团队，不自动补取保留期前项目", async () => {
    const { deps } = fixture({
      projects: [
        project("P1"),
        project("P2", { roomName: "B室" }),
        project("OLD", { createDate: "2026-05-01 00:00:00" }),
        project("OTHER", { teamName: "其他团队" })
      ]
    })
    deps.allowedRoomNames = ["A室"]
    expect(
      (await fetchProjectMetricProjects({ ...october, upperOrgLv1: ["B室"] }, {}, deps)).total
    ).toBe(0)
    expect((await fetchProjectMetricProjects(october, {}, deps)).total).toBe(1)
    await expect(fetchProjectMetricIndicatorExport(october, deps)).rejects.toThrow("全团队读取权限")
  })
})

describe("特性覆盖、月度占比和导出", () => {
  it("候选由周期室项目决定，分类可受其他室周期外项目影响，团队重新去重", async () => {
    const { deps } = fixture({
      projects: [
        project("P1"),
        project("P2", {
          roomName: "B室",
          firstStStartDate: "2026-09-01 00:00:00",
          featureCodes: ["F1", "F2"]
        }),
        project("P3", { roomName: "B室", featureCodes: ["F3"] })
      ],
      snapshots: [harness("P2")]
    })
    const room = await fetchProjectMetricOverview({ ...october, upperOrgLv1: ["A室"] }, deps)
    expect(room.features).toEqual({ total: 1, intelligent: 1, rate: 1 })
    const team = await fetchProjectMetricOverview(october, deps)
    expect(team.features).toEqual({ total: 2, intelligent: 1, rate: 0.5 })
  })
  it("全部室使用团队记录，多室分子分母相加，缺报不补零", async () => {
    const { deps } = fixture({
      monthly: [
        {
          teamName: PROJECT_METRIC_TEAM,
          timeRange: "2026-10",
          orgLevel: "team",
          totalPushedLines: 1000,
          devagentIdePushedLines: 200,
          devagentCloudPushedLines: 0
        },
        {
          teamName: PROJECT_METRIC_TEAM,
          timeRange: "2026-10",
          orgLevel: "room",
          roomName: "A室",
          totalPushedLines: 100,
          devagentIdePushedLines: 20,
          devagentCliPushedLines: 0
        },
        {
          teamName: PROJECT_METRIC_TEAM,
          timeRange: "2026-10",
          orgLevel: "room",
          roomName: "B室",
          totalPushedLines: 300,
          devagentIdePushedLines: 30
        }
      ]
    })
    const team = await fetchProjectMetricOverview(october, deps)
    expect(team.monthly).toMatchObject({
      totalPushedLines: 1000,
      cumulative: { pushedLines: null, rate: null, missing: true },
      sources: [{ rate: 0.2 }, { rate: 0 }, { rate: null, missing: true }, { rate: 0.1 }]
    })
    const rooms = await fetchProjectMetricOverview(
      { ...october, upperOrgLv1: ["A室", "B室"] },
      deps
    )
    expect(rooms.monthly).toMatchObject({
      totalPushedLines: 400,
      sources: [
        { pushedLines: 50, rate: 0.125 },
        { rate: null, missing: true },
        { rate: null, missing: true },
        { pushedLines: 100, rate: 0.25 }
      ]
    })
  })
  it("累计为四渠道行数之和除以同一分母，明确零计入，任一渠道缺失则不可用", async () => {
    const row = {
      teamName: PROJECT_METRIC_TEAM,
      timeRange: "2026-10",
      orgLevel: "team",
      totalPushedLines: 1000,
      devagentIdePushedLines: 200,
      devagentCloudPushedLines: 50,
      devagentCliPushedLines: 0
    }
    const { deps } = fixture({ monthly: [row] })
    const complete = await fetchProjectMetricOverview(october, deps)
    expect(complete.monthly?.cumulative).toEqual({ pushedLines: 350, rate: 0.35, missing: false })
    const exported = await fetchProjectMetricIndicatorExport(october, deps)
    const cumulativeRow = projectMetricIndicatorSheets(exported, october)[0].rows.find(
      (r) => r[0] === "AI 代码入库占比－累计 AI 入库代码"
    )
    expect(cumulativeRow?.slice(3, 5)).toEqual([35, "%"])
    const missing = fixture({ monthly: [{ ...row, devagentCloudPushedLines: null }] })
    expect((await fetchProjectMetricOverview(october, missing.deps)).monthly?.cumulative).toEqual({
      pushedLines: null,
      rate: null,
      missing: true
    })
    const codeFailure = fixture({ monthly: [row] })
    codeFailure.codeStats.mockRejectedValue(new Error("代码查询失败"))
    expect(
      (await fetchProjectMetricOverview(october, codeFailure.deps)).monthly?.cumulative
    ).toEqual({ pushedLines: null, rate: null, missing: true })
  })
  it("本月截止当前时间仍不显示渠道，完整自然月 mock 提供四渠道和累计", () => {
    expect(
      makeMockProjectMetricOverview({ range: { from: "2026-11-01", to: "2026-11-16" } }).monthly
    ).toBeNull()
    const monthly = makeMockProjectMetricOverview(october).monthly
    expect(monthly?.sources).toHaveLength(4)
    expect(monthly?.cumulative).toEqual({
      pushedLines: 224956,
      rate: 224956 / 1055649,
      missing: false
    })
  })
  it("非自然月不查询月度数据；零分母、重复填报均不产生错误比例", async () => {
    const { deps, queries } = fixture({
      monthly: [
        {
          teamName: PROJECT_METRIC_TEAM,
          timeRange: "2026-10",
          orgLevel: "team",
          totalPushedLines: 0,
          devagentIdePushedLines: 0
        }
      ]
    })
    expect(
      (await fetchProjectMetricOverview({ range: { from: "2026-10-02", to: "2026-10-31" } }, deps))
        .monthly
    ).toBeNull()
    expect(queries.some((q) => q.index === "monthly")).toBe(false)
    expect((await fetchProjectMetricOverview(october, deps)).monthly?.sources[0].rate).toBeNull()
  })
  it("重复填报记录明确报错，不合并成错误分母", async () => {
    const row = {
      teamName: PROJECT_METRIC_TEAM,
      timeRange: "2026-10",
      orgLevel: "team",
      totalPushedLines: 100
    }
    const { deps } = fixture({ monthly: [row, { ...row }] })
    const result = await fetchProjectMetricOverview(october, deps)
    expect(result.monthly).toBeNull()
    expect(result.monthlyError).toContain("重复填报")
    await expect(fetchProjectMetricIndicatorExport(october, deps)).rejects.toThrow("重复填报")
  })
  it("指标导出恰好两个Sheet，固定全团队及各室，不包含项目、组、趋势；百分比为数值", async () => {
    const { deps } = fixture({ projects: [project("P1"), project("P2", { roomName: "B室" })] })
    const data = await fetchProjectMetricIndicatorExport({ ...october, upperOrgLv1: ["B室"] }, deps)
    expect(data.rooms.map((r) => r.roomName)).toEqual(["A室", "B室"])
    expect(data.team.summary.groups.map((g) => g.projectCount)).toEqual([1, 1])
    expect(data.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const sheets = projectMetricIndicatorSheets(data, october)
    expect(sheets.map((s) => s.name)).toEqual(["团队指标", "各室指标"])
    expect(sheets[0].header).toEqual([
      "指标",
      "智能化项目",
      "常规项目",
      "总体",
      "单位",
      "时间口径",
      "口径说明"
    ])
    const workbook = XLSX.utils.book_new()
    for (const sheet of sheets)
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet([...sheet.summaryRows, [], sheet.header, ...sheet.rows]),
        sheet.name
      )
    const restored = XLSX.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), {
      type: "buffer"
    })
    expect(restored.SheetNames).toEqual(["团队指标", "各室指标"])
    const dataRows = XLSX.utils.sheet_to_json<(number | string)[]>(restored.Sheets["团队指标"], {
      header: 1
    })
    expect(dataRows.find((row) => row[0] === "AI代码入库率")?.[3]).toBe(50)
    expect(dataRows.find((row) => row[0] === "导出时间（GMT+8）")?.[1]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    )
    const rate = sheets[0].rows.find((r) => r[0] === "AI代码入库率")
    expect(rate?.slice(3, 5)).toEqual([50, "%"])
    expect(sheets[0].rows.filter((r) => String(r[0]).startsWith("AI 代码入库占比－"))).toHaveLength(
      5
    )
    const nonMonthly = await fetchProjectMetricIndicatorExport(
      { range: { from: "2026-10-02", to: "2026-10-31" } },
      deps
    )
    expect(
      projectMetricIndicatorSheets(nonMonthly, october)[0].rows.some((r) =>
        String(r[0]).startsWith("AI 代码入库占比－")
      )
    ).toBe(false)
  })
  it("超过10000条的快照及事实完整分页，工作日排序先全量计算再分页", async () => {
    const projects = Array.from({ length: 10003 }, (_, i) =>
      project(`P${String(i).padStart(5, "0")}`, {
        approvedDate: "2026-10-12 00:00:00",
        firstOnlineDate: i % 2 ? "2026-10-14 00:00:00" : null
      })
    )
    const { deps, queries } = fixture({
      projects,
      snapshots: projects.map((p) => harness(String(p.prjCode)))
    })
    const result = await fetchProjectMetricSummary(october, deps)
    expect(result.groups[0].projectCount).toBe(10003)
    expect(result.truncated).toBe(false)
    expect(queries.filter((q) => q.index === "projects").length).toBeGreaterThan(20)
    const list = await fetchProjectMetricProjects(
      october,
      { page: 501, pageSize: 20, sortBy: "deliveryDays", sortOrder: "desc" },
      deps
    )
    expect(list.total).toBe(10003)
    expect(list.items.length).toBe(3)
    expect(list.items.every((p) => p.deliveryDays === null)).toBe(true)
  }, 20000)
  it("查询超时、分片失败和缺失分页不会被当成完整成功", async () => {
    const { deps } = fixture()
    deps.query = async () => ({ timed_out: true })
    await expect(fetchProjectMetricSummary(october, deps)).rejects.toThrow("未完整返回")
  })
})
