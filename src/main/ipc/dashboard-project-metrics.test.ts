import { beforeEach, describe, expect, it, vi } from "vitest"
import * as XLSX from "xlsx"
import {
  PROJECT_METRIC_TEAM,
  type ProjectMetricFilters,
  type ProjectMetricListOptions,
  type ProjectMetricPeriodCode
} from "../../shared/project-metrics"
import {
  PROJECT_METRIC_SAMPLE_KEYS,
  projectMetricSampleReasons
} from "../../shared/project-metric-samples"
import { projectMetricIndicatorSheets } from "./project-metric-indicator-export"
import { PROJECT_METRIC_INDICATORS } from "../../shared/project-metric-indicators"
import { buildDashboardExcelBuffer, type DashboardExcelCell } from "./dashboard-excel-workbook"
import {
  fetchProjectMetricIndicatorExport,
  fetchProjectMetricOverview,
  fetchProjectMetricProjects,
  fetchProjectMetricSummary,
  fetchProjectMetricTrend,
  makeMockProjectMetricOverview,
  makeMockProjectMetricIndicatorExport,
  makeMockProjectMetricSummary,
  makeMockProjectMetricProjects,
  makeMockProjectMetricTrend,
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
const cellValue = (cell: DashboardExcelCell | undefined): number | string | undefined =>
  typeof cell === "object" ? cell.value : cell
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
  nameError = false,
  featureFacts = [
    { featureCode: "F1", featureName: "产品需求一", approvedDate: "2026-10-09 17:29:27" }
  ] as Doc[],
  cumulativeTotals = {} as Record<string, { lines: number; input: number; output: number }>,
  periodCodes = null as ProjectMetricPeriodCode[] | null
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
      const filters = (
        body.query as { bool: { filter: Array<{ terms?: Record<string, string[]> }> } }
      ).bool.filter
      const ids = Object.values(filters[0].terms ?? {})[0] ?? []
      const buckets = Object.entries(cumulativeTotals)
        .filter(([id]) => ids.includes(id))
        .map(([id, values]) => ({
          key: id,
          lines: { value: values.lines },
          input: { value: values.input },
          output: { value: values.output }
        }))
      return { aggregations: { projects: { buckets, sum_other_doc_count: 0 } } }
    }
    if (index === "features" && nameError) throw new Error("名称查询失败")
    const documents = index === "projects" ? projects : index === "monthly" ? monthly : featureFacts
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
  const codeEvidence = vi.fn(
    async (_range: ProjectMetricFilters["range"], ids: string[]) =>
      periodCodes ??
      (ids.length
        ? [
            {
              harnessProjectId: ids[0],
              roomName: "A室",
              pushedAdoptedLines: 100,
              pushedEffectiveGeneratedLines: 200
            }
          ]
        : [])
  )
  const deps: ProjectMetricDependencies = {
    query,
    codeStats,
    codeEvidence,
    eventIndex: "events",
    traceIndex: "traces",
    factIndex: "projects",
    featureIndex: "features",
    monthlyIndex: "monthly",
    allowedRoomNames: null
  }
  return { deps, queries, query, codeStats, codeEvidence }
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

describe("有效样本明细筛选", () => {
  it("同日审批晚于日期精度的立项仍以零耗时计入，跨日倒置继续排除", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", { approvedDate: "2026-10-12 17:00:00", createDate: "2026-10-12" }),
        project("P2", { approvedDate: "2026-10-13 09:00:00", createDate: "2026-10-12" }),
        project("P3", { approvedDate: "2026-10-12 17:00:00", createDate: "2026-10-12 09:00:00" })
      ],
      snapshots: [harness("P1"), harness("P2"), harness("P3")]
    })
    const summary = await fetchProjectMetricSummary(october, deps)
    expect(summary.groups[0].samples).toMatchObject({ approvalCreation: 2, approvalDevelopment: 3 })
    expect(summary.groups[0].avgApprovalCreationDays).toBe(0)
    const selected = await fetchProjectMetricProjects(
      october,
      { metricSample: "approvalCreation", developmentMode: "devclaw" },
      deps
    )
    expect(selected.total).toBe(2)
    expect(selected.items.map((item) => item.prjCode).sort()).toEqual(["P1", "P3"])
    expect(selected.items.every((item) => item.approvalCreationDays === 0)).toBe(true)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(
        projectMetricIndicatorSheets(
          await fetchProjectMetricIndicatorExport(october, deps),
          october
        )
      ),
      { type: "buffer" }
    )
    const rows = workbookTable(workbook, "项目依据", "项目编号").rows
    expect(rows.find((row) => row["项目编号"] === "P1")?.["特性审批完成到立项完成耗时"]).toBe(0)
    expect(rows.find((row) => row["项目编号"] === "P2")?.["特性审批完成到立项完成耗时"]).toBe("—")
  })
  it("各指标各分组的明细总数与汇总样本数一致，筛选在分页前完成，吞吐独立按上线日期", async () => {
    const facts = Array.from({ length: 60 }, (_, index) =>
      project(`P${String(index).padStart(2, "0")}`, {
        notAdjustFuns: index % 7 === 0 ? null : index % 4 === 0 ? 0 : 100,
        devWorkHours: index > 0 && index % 5 === 0 ? null : 152.25,
        bugNum: index % 4 === 0 ? null : 2,
        firstStStartDate: index === 0 ? "2026-09-30 12:00:00" : "2026-10-19 10:00:00",
        firstOnlineDate: index === 2 ? "2026-11-02 00:00:00" : "2026-10-25 00:00:00"
      })
    )
    const intelligent = facts.filter((_, index) => index % 2 === 1)
    const { deps, query } = fixture({
      projects: facts,
      snapshots: intelligent.map((item) => harness(String(item.prjCode))),
      cumulativeTotals: Object.fromEntries(
        intelligent.map((item, index) => [
          `h-${item.prjCode}`,
          { input: 1000, output: 100, lines: index % 3 ? 100 : 0 }
        ])
      )
    })
    const summary = await fetchProjectMetricSummary(october, deps)
    for (const group of summary.groups)
      for (const metricSample of PROJECT_METRIC_SAMPLE_KEYS) {
        const result = await fetchProjectMetricProjects(
          october,
          { metricSample, developmentMode: group.developmentMode },
          deps
        )
        expect(result.total).toBe(group.samples[metricSample])
        expect(result.items).toHaveLength(Math.min(20, result.total))
        expect(
          result.items.every(
            (item) =>
              item.developmentMode === group.developmentMode &&
              projectMetricSampleReasons(item, october)[metricSample] === null
          )
        ).toBe(true)
      }
    const page = await fetchProjectMetricProjects(
      october,
      { metricSample: "bug", developmentMode: "devclaw", page: 2, pageSize: 20 },
      deps
    )
    expect(page).toMatchObject({ total: 30, page: 2 })
    expect(page.items).toHaveLength(10)
    const all = await fetchProjectMetricProjects(
      october,
      { metricSample: "bug", developmentMode: "devclaw", exportAll: true },
      deps
    )
    expect(all.items).toHaveLength(30)
    expect(
      (
        await fetchProjectMetricProjects(
          october,
          { metricSample: "throughput", developmentMode: "non_devclaw", exportAll: true },
          deps
        )
      ).items.some((item) => item.prjCode === "P00")
    ).toBe(true)
    expect(
      (
        await fetchProjectMetricProjects(
          october,
          { metricSample: "throughput", developmentMode: "non_devclaw", exportAll: true },
          deps
        )
      ).items.some((item) => item.prjCode === "P02")
    ).toBe(false)
    const asymmetric = { ...october, adapterName: "plugin", tokenConsumptionMin: 1000000 }
    const regular = await fetchProjectMetricProjects(
      asymmetric,
      { metricSample: "bug", developmentMode: "non_devclaw" },
      deps
    )
    expect(regular.total).toBe(
      (await fetchProjectMetricSummary(asymmetric, deps)).groups[1].samples.bug
    )
    query.mockClear()
    await expect(
      fetchProjectMetricProjects(
        october,
        { metricSample: "unknown" as ProjectMetricListOptions["metricSample"] },
        deps
      )
    ).rejects.toThrow("样本筛选无效")
    expect(query).not.toHaveBeenCalled()
  })
  it("开发环境同样按有效样本查询，零耗时可见，包含跨月上线项目", () => {
    const filters = { ...october, upperOrgLv1: ["平台三部"] }
    const summary = makeMockProjectMetricSummary(filters)
    for (const group of summary.groups)
      for (const metricSample of PROJECT_METRIC_SAMPLE_KEYS) {
        const result = makeMockProjectMetricProjects(filters, {
          metricSample,
          developmentMode: group.developmentMode,
          exportAll: true
        })
        expect(result.total).toBe(group.samples[metricSample])
        expect(result.items).toHaveLength(result.total)
      }
    expect(
      makeMockProjectMetricProjects(october, {
        metricSample: "approvalCreation",
        keyword: "T26MCB25"
      }).items[0].approvalCreationDays
    ).toBe(0)
    expect(
      makeMockProjectMetricProjects(october, { metricSample: "throughput", keyword: "T26MCB23" })
        .total
    ).toBe(1)
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
    const sheet = projectMetricIndicatorSheets(exported, october)[0]
    const cumulativeRow = sheet.rows.find(
      (r) => r[1] === "代码入库情况－累计 AI 入库代码占比（硅碳比）"
    )
    expect(cellValue(cumulativeRow?.[sheet.header.indexOf("结果")])).toBe(35)
    expect(cumulativeRow?.[sheet.header.indexOf("结果")]).toMatchObject({
      numberFormat: '0.00"%"'
    })
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
      pushedLines: 229956,
      rate: 229956 / 1055649,
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
  it("指标导出恰好五个Sheet，固定全团队及各室，保留共用依据、公式和数值", async () => {
    const { deps } = fixture({ projects: [project("P1"), project("P2", { roomName: "B室" })] })
    const data = await fetchProjectMetricIndicatorExport({ ...october, upperOrgLv1: ["B室"] }, deps)
    expect(data.rooms.map((r) => r.roomName)).toEqual(["A室", "B室"])
    expect(data.team.summary.groups.map((g) => g.projectCount)).toEqual([1, 1])
    expect(data.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const sheets = projectMetricIndicatorSheets(data, october)
    expect(sheets.map((s) => s.name)).toEqual([
      "团队指标",
      "各室指标",
      "项目依据",
      "特性依据",
      "代码入库依据"
    ])
    expect(sheets[0].header).toContain("分子")
    expect(sheets[0].header).toContain("分母")
    expect(sheets[0].header).not.toContain("差异")
    const restored = XLSX.read(await buildDashboardExcelBuffer(sheets), {
      type: "buffer",
      cellFormula: true
    })
    expect(restored.SheetNames).toEqual([
      "团队指标",
      "各室指标",
      "项目依据",
      "特性依据",
      "代码入库依据"
    ])
    const dataRows = XLSX.utils.sheet_to_json<(number | string)[]>(restored.Sheets["团队指标"], {
      header: 1
    })
    expect(
      dataRows.find((row) => row[1] === "AI代码入库率")?.[sheets[0].header.indexOf("结果")]
    ).toBe(50)
    expect(dataRows.find((row) => row[0] === "导出时间（GMT+8）")?.[1]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    )
    const rate = sheets[0].rows.find((r) => r[1] === "AI代码入库率")
    expect(cellValue(rate?.[sheets[0].header.indexOf("结果")])).toBe(50)
    expect(sheets[0].rows.filter((r) => String(r[1]).startsWith("代码入库情况－"))).toHaveLength(5)
    const nonMonthly = await fetchProjectMetricIndicatorExport(
      { range: { from: "2026-10-02", to: "2026-10-31" } },
      deps
    )
    expect(
      projectMetricIndicatorSheets(nonMonthly, october)[0].rows.some((r) =>
        String(r[1]).startsWith("代码入库情况－")
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

// 按工作簿实际引用的依据单元格独立求和，不读取汇总缓存值来反推分子分母。
function evaluateEvidenceFormula(workbook: XLSX.WorkBook, formula: string): number {
  const calls = [...formula.matchAll(/(SUMIFS|COUNTIFS)\(([^()]*)\)/g)]
  if (formula === "0") return 0
  expect(calls.length).toBeGreaterThan(0)
  expect(formula.replace(/(?:SUMIFS|COUNTIFS)\(([^()]*)\)/g, "x").replace(/[x()+\s]/g, "")).toBe("")
  return calls.reduce((total, call) => {
    const counting = call[1] === "COUNTIFS"
    const args = call[2].split(",")
    const readRange = (ref: string): unknown[] => {
      const matched = /^'([^']+)'!(.+)$/.exec(ref)
      if (!matched) throw new Error(`不正确的依据引用 ${ref}`)
      expect(["项目依据", "特性依据", "代码入库依据"]).toContain(matched[1])
      const range = XLSX.utils.decode_range(matched[2])
      expect(range.s.c).toBe(range.e.c)
      return Array.from(
        { length: range.e.r - range.s.r + 1 },
        (_, i) =>
          workbook.Sheets[matched[1]][XLSX.utils.encode_cell({ c: range.s.c, r: range.s.r + i })]?.v
      )
    }
    const values = readRange(args[0])
    const offset = counting ? 0 : 1
    const conditions = Array.from({ length: (args.length - offset) / 2 }, (_, i) => ({
      values: readRange(args[offset + i * 2]),
      expected: args[offset + 1 + i * 2].startsWith('"')
        ? args[offset + 1 + i * 2]
            .slice(1, -1)
            .replace(/""/g, '"')
            .replace(/~([~*?])/g, "$1")
        : Number(args[offset + 1 + i * 2])
    }))
    for (const condition of conditions) expect(condition.values).toHaveLength(values.length)
    return (
      total +
      values.reduce<number>(
        (sum, value, i) =>
          sum +
          (conditions.every((c) =>
            c.expected === ">=0"
              ? typeof c.values[i] === "number" && Number(c.values[i]) >= 0
              : c.expected === ">0"
                ? typeof c.values[i] === "number" && Number(c.values[i]) > 0
                : c.values[i] === c.expected
          )
            ? counting
              ? 1
              : typeof value === "number"
                ? value
                : 0
            : 0),
        0
      )
    )
  }, 0)
}
function workbookTable(workbook: XLSX.WorkBook, name: string, firstHeader: string) {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
    header: 1,
    defval: "—"
  })
  const index = rows.findIndex((r) => r[0] === firstHeader)
  if (index < 0) throw new Error(`缺少表头 ${name}`)
  const header = rows[index].map(String)
  return {
    header,
    startRow: index + 2,
    rows: rows
      .slice(index + 1)
      .map((row) => Object.fromEntries(header.map((label, i) => [label, row[i]])))
  }
}

describe("五Sheet指标追溯", () => {
  it("23项指标从共用原始数据复算，跨室分类、上线样本、缺字段和多关联均与汇总一致", async () => {
    const base = {
      approvedDate: "2026-10-12 00:00:00",
      createDate: "2026-10-13 00:00:00",
      firstStStartDate: "2026-10-15 00:00:00",
      firstOnlineDate: "2026-10-16 00:00:00"
    }
    const projects = [
      project("P001", {
        ...base,
        featureCodes: ["F001"],
        notAdjustFuns: 30,
        devWorkHours: 152.25,
        bugNum: 2,
        kenanIssueCount: 3,
        kenanIssueCategoryCount: [
          { category: "安全", count: 2 },
          { category: "性能", count: 1 }
        ]
      }),
      project("P002", {
        ...base,
        roomName: "B室",
        featureCodes: ["F001"],
        createDate: "2026-10-14 00:00:00",
        firstStStartDate: null,
        firstUatStartDate: "2026-10-16 00:00:00",
        firstOnlineDate: "2026-10-19 00:00:00",
        notAdjustFuns: 60,
        devWorkHours: 304.5,
        bugNum: 4
      }),
      project("P003", {
        ...base,
        featureCodes: ["F002"],
        notAdjustFuns: null,
        devWorkHours: 152.25,
        firstOnlineDate: "2026-10-20 00:00:00",
        bugNum: 1,
        kenanIssueCount: 1,
        kenanIssueCategoryCount: [{ category: "安全", count: 1 }]
      }),
      project("P004", {
        ...base,
        featureCodes: ["F003"],
        approvedDate: "2026-09-28 00:00:00",
        createDate: "2026-09-29 00:00:00",
        firstStStartDate: "2026-09-30 00:00:00",
        firstOnlineDate: "2026-10-21 00:00:00",
        notAdjustFuns: 20,
        devWorkHours: 76.125
      })
    ]
    const monthly = [
      {
        orgLevel: "team",
        totalPushedLines: 30000,
        devagentIdePushedLines: 3000,
        devagentCloudPushedLines: 1500,
        devagentCliPushedLines: 1500
      },
      {
        orgLevel: "room",
        roomName: "A室",
        totalPushedLines: 10000,
        devagentIdePushedLines: 1000,
        devagentCloudPushedLines: 500,
        devagentCliPushedLines: 500
      },
      {
        orgLevel: "room",
        roomName: "B室",
        totalPushedLines: 20000,
        devagentIdePushedLines: 2000,
        devagentCloudPushedLines: 1000,
        devagentCliPushedLines: 1000
      }
    ].map((row) => ({ ...row, teamName: PROJECT_METRIC_TEAM, timeRange: "2026-10" }))
    const { deps, codeStats } = fixture({
      projects,
      monthly,
      snapshots: [
        harness("P002"),
        harness("P003"),
        harness("P003", "h-P003-extra"),
        harness("P004")
      ],
      featureFacts: [
        { featureCode: "F001", featureName: "客户资料优化", approvedDate: "2026-10-12 00:00:00" },
        { featureCode: "F002", featureName: "客户查询优化", approvedDate: "2026-10-12 00:00:00" },
        { featureCode: "F003", featureName: "存量功能优化", approvedDate: "2026-09-28 00:00:00" }
      ],
      cumulativeTotals: {
        "h-P002": { input: 12000, output: 2400, lines: 200 },
        "h-P003": { input: 3000, output: 600, lines: 100 },
        "h-P004": { input: 1000, output: 200, lines: 50 }
      },
      periodCodes: [
        {
          harnessProjectId: "h-P002",
          roomName: "B室",
          pushedAdoptedLines: 500,
          pushedEffectiveGeneratedLines: 1000
        },
        {
          harnessProjectId: "h-P003",
          roomName: "A室",
          pushedAdoptedLines: 100,
          pushedEffectiveGeneratedLines: 200
        },
        {
          harnessProjectId: "h-P003-extra",
          roomName: "A室",
          pushedAdoptedLines: 100,
          pushedEffectiveGeneratedLines: 200
        },
        {
          harnessProjectId: "h-P004",
          roomName: "A室",
          pushedAdoptedLines: 300,
          pushedEffectiveGeneratedLines: 600
        }
      ]
    })
    const data = await fetchProjectMetricIndicatorExport(october, deps)
    expect(codeStats).not.toHaveBeenCalled() // 依据与汇总共用周期项目聚合，不另查组织总计。
    expect(data.evidence.projects).toHaveLength(4)
    expect(data.evidence.code).toHaveLength(3)
    expect(data.evidence.code.find((c) => c.prjCode === "P003")?.pushedAdoptedLines).toBe(200)
    expect(data.team.summary.groups[0].inputTokensPerAdoptedLine).toBe(50)
    const sheets = projectMetricIndicatorSheets(data, october)
    const expectedMetrics = [
      "应用研发智能化特性占比",
      "AI代码入库率",
      "月人均产出功能点",
      "月人均特性吞吐率",
      "特性审批完成到开发完成耗时",
      "特性审批完成到立项完成耗时",
      "平均缺陷数",
      "平均非功能问题数",
      "平均功能点",
      "平均缺陷密度",
      "平均发起 ST 耗时",
      "平均发起 UAT 耗时",
      "平均特性上线耗时",
      "平均输入 Token",
      "平均输出 Token",
      "平均代码行数",
      "平均单行代码消耗输入 Token",
      "平均单行代码消耗输出 Token",
      "代码入库情况－累计 AI 入库代码占比（硅碳比）",
      "代码入库情况－devagent-ide",
      "代码入库情况－devagent-cloud",
      "代码入库情况－devagent-cli",
      "代码入库情况－CMBDevClaw"
    ]
    expect(new Set(sheets[0].rows.map((r) => r[1]))).toEqual(
      new Set([...expectedMetrics, "平均非功能问题数－安全", "平均非功能问题数－性能"])
    )
    const workbook = XLSX.read(await buildDashboardExcelBuffer(sheets), {
      type: "buffer",
      cellFormula: true,
      cellNF: true
    })
    expect(workbook.SheetNames).toEqual([
      "团队指标",
      "各室指标",
      "项目依据",
      "特性依据",
      "代码入库依据"
    ])
    for (const name of ["团队指标", "各室指标"]) {
      const table = workbookTable(workbook, name, "统计组织")
      expect(table.header).not.toContain("看板结果")
      expect(table.header).not.toContain("差异")
      for (const removed of ["分子单位", "分母单位", "换算系数", "时间依据", "结果单位"])
        expect(table.header).not.toContain(removed)
      expect(table.header.slice(0, 4)).toEqual(["统计组织", "指标", "结果", "项目类型或来源"])
      for (const organization of new Set(table.rows.map((row) => row["统计组织"]))) {
        const rows = table.rows.filter((row) => row["统计组织"] === organization)
        for (const metric of new Set(
          rows
            .filter((row) => ["智能化", "常规"].includes(String(row["项目类型或来源"])))
            .map((row) => row["指标"])
        )) {
          const first = rows.findIndex((row) => row["指标"] === metric)
          expect(rows.filter((row) => row["指标"] === metric)).toHaveLength(2)
          expect(
            rows.slice(first, first + 2).map((row) => [row["指标"], row["项目类型或来源"]])
          ).toEqual([
            [metric, "智能化"],
            [metric, "常规"]
          ])
          for (const label of ["分子名称", "分母名称"]) {
            expect(rows[first][label]).not.toBe("")
            expect(rows[first + 1][label]).toBe("")
          }
          if (
            (metric === "平均缺陷数" && organization !== "B室") ||
            String(metric).startsWith("平均非功能问题数－")
          )
            expect(rows[first + 1]["计算说明"]).toBe("")
          if (
            (metric === "平均缺陷数" && organization === "B室") ||
            (metric === "平均输入 Token" && organization !== "B室")
          )
            expect(rows[first + 1]["计算说明"]).toContain("无有效样本")
        }
      }
      const nIndex = table.header.indexOf("分子"),
        dIndex = table.header.indexOf("分母"),
        rIndex = table.header.indexOf("结果")
      for (let i = 0; i < table.rows.length; i++) {
        const row = table.rows[i]
        const nCell =
          workbook.Sheets[name][XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: nIndex })]
        const dCell =
          workbook.Sheets[name][XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: dIndex })]
        const result =
          workbook.Sheets[name][XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: rIndex })]
        const metric = String(row["指标"])
        const percentage =
          metric === "应用研发智能化特性占比" ||
          metric === "AI代码入库率" ||
          metric.startsWith("代码入库情况－")
        const unit = percentage
          ? "%"
          : (PROJECT_METRIC_INDICATORS.find((item) => item.label === metric)?.unit ?? "个")
        expect(result.z).toBe(`0.00"${unit === "%" ? "" : " "}${unit}"`)
        if (nCell.v === "—" || dCell.v === "—") {
          expect(result.v).toBe("—")
          expect(XLSX.utils.format_cell(result)).toBe("—")
          continue
        }
        expect(nCell.f).toBeTruthy()
        expect(dCell.f).toBeTruthy()
        const numerator = evaluateEvidenceFormula(workbook, nCell.f!)
        const denominator = evaluateEvidenceFormula(workbook, dCell.f!)
        expect(numerator).toBeCloseTo(Number(nCell.v), 8)
        expect(denominator).toBeCloseTo(Number(dCell.v), 8)
        expect(result.f).toContain("ISNUMBER")
        const factor =
          row["指标"] === "月人均产出功能点" || row["指标"] === "月人均特性吞吐率"
            ? 152.25
            : percentage || row["指标"] === "平均缺陷密度"
              ? 100
              : 1
        const n = XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: nIndex })
        const d = XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: dIndex })
        expect(result.f).toBe(
          `IF(AND(ISNUMBER(${n}),ISNUMBER(${d}),${d}>0),${n}*${factor}/${d},"—")`
        )
        if (denominator > 0) {
          expect(result.t).toBe("n")
          expect(result.v).toBeCloseTo((numerator * factor) / denominator, 8)
          expect(XLSX.utils.format_cell(result)).toBe(
            `${Number(result.v).toFixed(2)}${unit === "%" ? "" : " "}${unit}`
          )
        } else expect(result.v).toBe("—")
        for (const label of ["分子依据", "分母依据"]) {
          const linked =
            workbook.Sheets[name][
              XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: table.header.indexOf(label) })
            ].l?.Target
          expect(linked).toMatch(/^#'(项目依据|特性依据|代码入库依据)'!A\d+$/)
        }
      }
    }
    const projectRows = workbookTable(workbook, "项目依据", "项目编号").rows
    expect(projectRows).toHaveLength(4)
    expect(projectRows.find((r) => r["项目编号"] === "P003")).toMatchObject({
      "开发报工小时（功能点产出）": "—",
      "开发报工小时（特性吞吐）": 152.25,
      特性审批完成到开发完成耗时: 3
    })
    expect(projectRows.find((r) => r["项目编号"] === "P004")).toMatchObject({
      功能点: "—",
      "开发报工小时（特性吞吐）": 76.125
    })
    const projectHeader = workbookTable(workbook, "项目依据", "项目编号").header
    expect(projectHeader.some((label) => /参与|命中|核对|同步|最早审批特性编号/.test(label))).toBe(
      false
    )
    expect(projectHeader.length).toBeLessThan(40)
    expect(projectHeader.some((label) => /平均|合计/.test(label))).toBe(false)
    expect(projectHeader.filter((label) => label === "功能点")).toHaveLength(1)
    expect(projectHeader.filter((label) => label === "缺陷数")).toHaveLength(1)
    expect(projectHeader.some((label) => /人月产出计算|缺陷密度计算/.test(label))).toBe(false)
    expect(projectHeader.slice(8, 25)).toEqual([
      "功能点",
      "开发报工小时（功能点产出）",
      "开发报工小时（特性吞吐）",
      "特性审批完成到开发完成耗时",
      "特性审批完成到立项完成耗时",
      "缺陷数",
      "非功能问题数",
      "立项至首次 ST 发起耗时",
      "立项至首次 UAT 发起耗时",
      "特性审批至首次上线耗时",
      "累计输入 Token",
      "累计输出 Token",
      "累计已 Push 采纳行数",
      "累计输入 Token（单行消耗计算）",
      "已 Push 采纳行数（输入 Token 单行消耗）",
      "累计输出 Token（单行消耗计算）",
      "已 Push 采纳行数（输出 Token 单行消耗）"
    ])
    expect(projectHeader.slice(-6)).toEqual([
      "项目最早特性审批完成日期",
      "立项日期",
      "首次ST发起日期",
      "首次UAT发起日期",
      "开发完成日期",
      "首次上线日期"
    ])
    expect(projectHeader).toEqual(
      expect.arrayContaining([
        "缺陷数",
        "非功能问题数",
        "功能点",
        "累计输入 Token",
        "累计输出 Token",
        "累计已 Push 采纳行数",
        "立项至首次 ST 发起耗时",
        "立项至首次 UAT 发起耗时",
        "特性审批至首次上线耗时"
      ])
    )
    const codeTable = workbookTable(workbook, "代码入库依据", "统计层级")
    expect(codeTable.header).toContain("项目模式项目编号")
    expect(codeTable.header).not.toContain("企业项目编号")
    expect(codeTable.rows.filter((row) => row["数据来源"] === "CMBDevClaw")).toHaveLength(3)
    expect(
      codeTable.rows
        .filter((row) => row["数据来源"] === "CMBDevClaw")
        .every((row) => row["统计层级"] === "室")
    ).toBe(true)
    expect(codeTable.header).toContain("入库代码行数")
    expect(codeTable.header).not.toContain("该来源入库行数")
    expect(codeTable.header).not.toContain("组织累计入库行数")
    expect(
      codeTable.rows.find((row) => row["统计层级"] === "团队" && row["数据来源"] === "组织累计入库")
    ).toMatchObject({
      入库代码行数: 30000
    })
    expect(
      codeTable.rows.find((row) => row["统计层级"] === "团队" && row["数据来源"] === "devagent-ide")
    ).toMatchObject({
      入库代码行数: 3000
    })
    const featureHeaders = workbookTable(workbook, "特性依据", "统计层级").header
    expect(featureHeaders).not.toContain("项目类型")
    expect(featureHeaders.slice(8)).toEqual([
      "对应用研发智能化特性占比分子贡献",
      "对应用研发智能化特性占比分母贡献",
      "对月人均特性吞吐率分子贡献（智能化项目）",
      "对月人均特性吞吐率分子贡献（常规项目）",
      "应用研发智能化特性占比分类（按全部关联项目判断）",
      "特性审批完成日期"
    ])
    expect(featureHeaders).toEqual(
      expect.arrayContaining([
        "应用研发智能化特性占比分类（按全部关联项目判断）",
        "对应用研发智能化特性占比分母贡献",
        "对应用研发智能化特性占比分子贡献",
        "对月人均特性吞吐率分子贡献（智能化项目）",
        "对月人均特性吞吐率分子贡献（常规项目）"
      ])
    )
    const aFeature = workbookTable(workbook, "特性依据", "统计层级").rows.filter(
      (r) => r["统计组织"] === "A室"
    )
    expect(
      aFeature.reduce((n, r) => n + (Number(r["对应用研发智能化特性占比分母贡献"]) || 0), 0)
    ).toBe(2)
    expect(
      aFeature.reduce((n, r) => n + (Number(r["对应用研发智能化特性占比分子贡献"]) || 0), 0)
    ).toBe(2)
    expect(
      aFeature.find((r) => r["特性编号"] === "F001" && r["关联项目编号"] === "P002")
    ).toMatchObject({
      项目所属室: "B室",
      "应用研发智能化特性占比分类（按全部关联项目判断）": "智能化",
      对应用研发智能化特性占比分母贡献: "—"
    })
    const roomRows = workbookTable(workbook, "各室指标", "统计组织").rows
    expect(
      roomRows.find(
        (r) =>
          r["统计组织"] === "A室" &&
          r["指标"] === "月人均特性吞吐率" &&
          r["项目类型或来源"] === "智能化"
      )?.["结果"]
    ).toBeCloseTo(4 / 3)
    expect(
      roomRows.find(
        (r) =>
          r["统计组织"] === "A室" && r["指标"] === "代码入库情况－累计 AI 入库代码占比（硅碳比）"
      )?.["结果"]
    ).toBe(25)
  })
  it("仅有周期代码的项目保留在代码依据，审批日期仍使用项目事实，未填报不补零", async () => {
    const { deps } = fixture({
      snapshots: [harness("P1"), harness("OLD")],
      featureFacts: [
        { featureCode: "F1", featureName: "产品需求一", approvedDate: "2026-10-01 00:00:00" }
      ],
      periodCodes: [
        {
          harnessProjectId: "h-OLD",
          roomName: "A室",
          pushedAdoptedLines: 80,
          pushedEffectiveGeneratedLines: 100
        }
      ],
      monthly: [
        {
          orgLevel: "team",
          teamName: PROJECT_METRIC_TEAM,
          timeRange: "2026-10",
          totalPushedLines: 1000,
          devagentIdePushedLines: 0
        }
      ]
    })
    const data = await fetchProjectMetricIndicatorExport(october, deps)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(data, october)),
      { type: "buffer" }
    )
    const rows = workbookTable(workbook, "项目依据", "项目编号").rows
    expect(rows.some((r) => r["项目编号"] === "OLD")).toBe(false)
    expect(rows.find((r) => r["项目编号"] === "P1")?.["项目最早特性审批完成日期"]).toBe(
      "2026-10-09 17:29:27"
    )
    const code = workbookTable(workbook, "代码入库依据", "统计层级").rows
    expect(code.find((r) => r["项目模式项目编号"] === "OLD")).toMatchObject({
      统计层级: "室",
      入库代码行数: 80,
      对应已Push有效生成行数: 100
    })
    const summary = workbookTable(workbook, "团队指标", "统计组织").rows
    expect(summary.find((r) => r["指标"] === "AI代码入库率")?.["结果"]).toBe(80)
    expect(summary.find((r) => r["指标"] === "代码入库情况－devagent-ide")?.["结果"]).toBe(0)
    expect(summary.find((r) => r["指标"] === "代码入库情况－devagent-cloud")?.["结果"]).toBe("—")
    expect(
      summary.find((r) => r["指标"] === "代码入库情况－累计 AI 入库代码占比（硅碳比）")?.["结果"]
    ).toBe("—")
  })
  it("高级筛选不改变特性覆盖候选，被筛除项目仅保留在特性依据", async () => {
    const { deps } = fixture({ projects: [project("P1", { notAdjustFuns: 10 })] })
    const filters = { ...october, functionPointMin: 50 }
    const data = await fetchProjectMetricIndicatorExport(filters, deps)
    expect(data.team.summary.groups[0].projectCount).toBe(0)
    expect(data.team.overview.features).toEqual({ total: 1, intelligent: 1, rate: 1 })
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(data, filters)),
      { type: "buffer" }
    )
    expect(workbookTable(workbook, "项目依据", "项目编号").rows).toHaveLength(0)
    expect(
      workbookTable(workbook, "特性依据", "统计层级").rows.some(
        (row) => row["关联项目编号"] === "P1" && row["对应用研发智能化特性占比分母贡献"] === 1
      )
    ).toBe(true)
  })
  it("立项日期筛选影响共用样本，缺少日期的指标显示—，开发完成日期仍优先ST", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", {
          firstStStartDate: "2026-11-01 00:00:00",
          firstOnlineDate: "2026-11-15 00:00:00"
        })
      ]
    })
    const ordinary = await fetchProjectMetricIndicatorExport(october, deps)
    expect(ordinary.team.summary.groups[0].projectCount).toBe(0)
    const filters: ProjectMetricFilters = { ...october, dateBasis: "created" }
    const created = await fetchProjectMetricIndicatorExport(filters, deps)
    expect(created.team.summary.groups[0].projectCount).toBe(1)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(created, filters)),
      { type: "buffer" }
    )
    const row = workbookTable(workbook, "项目依据", "项目编号").rows[0]
    expect(row["功能点"]).toBe(214.72)
    expect(row["立项至首次 UAT 发起耗时"]).toBe("—")
    expect(row["开发完成日期"]).toBe("2026-11-01 00:00:00")
  })
  it("有效零值参与计数，缺少报工只退出相关指标，按室可直接复算分子分母", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", { notAdjustFuns: 0, devWorkHours: 0, bugNum: 0 }),
        project("P2", { notAdjustFuns: 30, devWorkHours: null }),
        project("P3", { roomName: "B室", notAdjustFuns: 60, devWorkHours: 152.25 })
      ],
      snapshots: [harness("P1"), harness("P2"), harness("P3")]
    })
    const data = await fetchProjectMetricIndicatorExport(october, deps)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(data, october)),
      { type: "buffer", cellFormula: true }
    )
    const projects = workbookTable(workbook, "项目依据", "项目编号").rows
    const aRoom = projects.filter((row) => row["项目所属室"] === "A室")
    expect(aRoom.find((row) => row["项目编号"] === "P1")).toMatchObject({
      功能点: 0,
      缺陷数: 0,
      "开发报工小时（功能点产出）": 0
    })
    expect(aRoom.find((row) => row["项目编号"] === "P2")).toMatchObject({
      功能点: 30,
      "开发报工小时（功能点产出）": "—"
    })
    const values = aRoom
      .map((row) => row["功能点"])
      .filter((v): v is number => typeof v === "number")
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    const room = workbookTable(workbook, "各室指标", "统计组织").rows.find(
      (row) =>
        row["统计组织"] === "A室" &&
        row["指标"] === "平均功能点" &&
        row["项目类型或来源"] === "智能化"
    )!
    expect(room["分母"]).toBe(2)
    expect(room["结果"]).toBe(mean)
    for (const name of ["团队指标", "各室指标"]) {
      const table = workbookTable(workbook, name, "统计组织")
      for (let i = 0; i < table.rows.length; i++)
        for (const operand of ["分子", "分母"]) {
          const ref = XLSX.utils.encode_cell({
            r: table.startRow - 1 + i,
            c: table.header.indexOf(operand)
          })
          const exported = workbook.Sheets[name][ref]
          if (typeof exported.v === "number")
            expect(evaluateEvidenceFormula(workbook, exported.f!)).toBeCloseTo(exported.v, 8)
        }
    }
  })
  it("共用功能点与缺陷数列时，缺工时、缺陷缺失及零功能点仍按各指标条件排除", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", { notAdjustFuns: 0, bugNum: 7, devWorkHours: 0 }),
        project("P2", { notAdjustFuns: 30, bugNum: null, devWorkHours: 152.25 }),
        project("P3", { notAdjustFuns: 60, bugNum: 3, devWorkHours: null }),
        project("P4", { notAdjustFuns: 90, bugNum: 0, devWorkHours: 152.25 })
      ],
      snapshots: [harness("P1"), harness("P2"), harness("P3"), harness("P4")]
    })
    const data = await fetchProjectMetricIndicatorExport(october, deps)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(data, october)),
      {
        type: "buffer",
        cellFormula: true
      }
    )
    const projects = workbookTable(workbook, "项目依据", "项目编号").rows
    expect(projects.map((row) => row["功能点"])).toEqual([0, 30, 60, 90])
    expect(projects.map((row) => row["缺陷数"])).toEqual([7, "—", 3, 0])
    const team = workbookTable(workbook, "团队指标", "统计组织")
    for (const [metric, numerator, denominator, result, samples] of [
      ["月人均产出功能点", 120, 304.5, 60, 3],
      ["平均缺陷密度", 3, 150, 2, 2],
      ["平均功能点", 180, 4, 45, 4],
      ["平均缺陷数", 10, 3, 10 / 3, 3]
    ] as const) {
      const index = team.rows.findIndex(
        (row) => row["指标"] === metric && row["项目类型或来源"] === "智能化"
      )
      expect(team.rows[index]).toMatchObject({
        分子: numerator,
        分母: denominator,
        结果: result,
        有效样本项目数: samples
      })
      for (const [name, expected] of [
        ["分子", numerator],
        ["分母", denominator]
      ] as const) {
        const ref = XLSX.utils.encode_cell({
          r: team.startRow - 1 + index,
          c: team.header.indexOf(name)
        })
        expect(evaluateEvidenceFormula(workbook, workbook.Sheets["团队指标"][ref].f!)).toBeCloseTo(
          expected,
          8
        )
      }
    }
  })
  it("周期外项目只留在特性关联中，全局分类不变，也不生成错误项目跳转", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", { featureCodes: ["F1"] }),
        project("P2", {
          roomName: "B室",
          featureCodes: ["F1"],
          createDate: "2026-09-01 00:00:00",
          firstStStartDate: "2026-09-10 00:00:00",
          firstOnlineDate: "2026-09-15 00:00:00"
        })
      ],
      snapshots: [harness("P2")],
      periodCodes: []
    })
    const data = await fetchProjectMetricIndicatorExport(october, deps)
    const sheets = projectMetricIndicatorSheets(data, october)
    const workbook = XLSX.read(await buildDashboardExcelBuffer(sheets), { type: "buffer" })
    expect(
      workbookTable(workbook, "项目依据", "项目编号").rows.map((row) => row["项目编号"])
    ).toEqual(["P1"])
    const references = workbookTable(workbook, "特性依据", "统计层级").rows
    expect(
      references.find((row) => row["统计组织"] === "A室" && row["关联项目编号"] === "P2")
    ).toMatchObject({
      项目所属室: "B室",
      "应用研发智能化特性占比分类（按全部关联项目判断）": "智能化",
      对应用研发智能化特性占比分母贡献: "—"
    })
    expect(data.team.overview.features).toEqual({ total: 1, intelligent: 1, rate: 1 })
    const feature = sheets.find((sheet) => sheet.name === "特性依据")!
    const projectColumn = feature.header.indexOf("关联项目编号")
    expect(feature.rows.some((row) => row[projectColumn] === "P2")).toBe(true)
    expect(feature.header.some((label) => /标记|核对|同步/.test(label))).toBe(false)
  })
  it("开发模式也可导出五个Sheet，通用字符串数字工作簿仍可正常保存", async () => {
    const mock = makeMockProjectMetricIndicatorExport(october)
    const file = await buildDashboardExcelBuffer(projectMetricIndicatorSheets(mock, october))
    expect(XLSX.read(file, { type: "buffer" }).SheetNames).toHaveLength(5)
    const ordinary = await buildDashboardExcelBuffer([
      {
        name: "原有导出",
        header: ["姓名", "数量"],
        summaryRows: [["说明", "普通导出"]],
        rows: [["示例", 0]]
      }
    ])
    expect(
      XLSX.utils.sheet_to_json(XLSX.read(ordinary, { type: "buffer" }).Sheets["原有导出"], {
        header: 1
      })
    ).toEqual([["说明", "普通导出"], [], ["姓名", "数量"], ["示例", 0]])
  })
})

describe("2026年10月完整mock", () => {
  it("12个项目与12个特性覆盖三个室，概览、对比、导出共享相同数据", () => {
    const data = makeMockProjectMetricIndicatorExport(october)
    expect(data.evidence.projects).toHaveLength(12)
    expect(data.evidence.features).toHaveLength(12)
    expect(
      data.evidence.projects.filter(({ project }) => project.developmentMode === "devclaw")
    ).toHaveLength(6)
    expect(data.evidence.code).toHaveLength(7)
    expect(data.rooms.map((room) => room.roomName)).toEqual(["测试 1 部", "开发二部", "平台三部"])
    expect(data.team.summary).toEqual(makeMockProjectMetricSummary(october))
    expect(data.team.summary.groups.map((group) => group.projectCount)).toEqual([5, 6])
    expect(data.team.overview).toEqual(makeMockProjectMetricOverview(october))
    expect(data.team.overview.features).toEqual({ total: 12, intelligent: 8, rate: 8 / 12 })
    expect(data.team.overview.code).toEqual({
      pushedAdoptedLines: 6800,
      pushedEffectiveGeneratedLines: 8500,
      pushedAdoptionRate: 0.8
    })
    for (const room of data.rooms) {
      const filters = { ...october, upperOrgLv1: [room.roomName] }
      expect(room.summary).toEqual(makeMockProjectMetricSummary(filters))
      expect(room.overview).toEqual(makeMockProjectMetricOverview(filters))
      expect(room.overview.monthly?.totalPushedLines).toBeGreaterThan(0)
    }
    expect(data.rooms.reduce((sum, room) => sum + room.overview.features!.total, 0)).toBe(13)
    const b = makeMockProjectMetricOverview({ ...october, upperOrgLv1: ["开发二部"] })
    expect(b.features).toEqual({ total: 4, intelligent: 3, rate: 0.75 })
    expect(b.code?.pushedAdoptedLines).toBe(2300)
    expect(makeMockProjectMetricOverview({ ...october, functionPointMin: 99999 })).toEqual(
      data.team.overview
    )
  })
  it("日期、组织、阶段、搜索和排序筛选真实生效，字段缺失与跨月上线各自影响指标", () => {
    const development = makeMockProjectMetricProjects(october)
    expect(development.total).toBe(11)
    expect(
      development.items.every((project) => project.features.every((feature) => feature.featureName))
    ).toBe(true)
    expect(development.items.some((project) => project.prjCode === "T26MCB23")).toBe(false)
    const created = makeMockProjectMetricProjects({ ...october, dateBasis: "created" })
    expect(created.total).toBe(9)
    expect(makeMockProjectMetricProjects(october, { keyword: "T26MCB24" }).items[0]).toMatchObject({
      firstStStartDate: null,
      firstUatStartDate: "2026-10-15 14:30:00",
      developmentMode: "non_devclaw"
    })
    const room = makeMockProjectMetricProjects(
      { ...october, upperOrgLv1: ["测试 1 部"] },
      { sortBy: "bugNum", sortOrder: "asc" }
    )
    expect(room.items.map((project) => project.bugNum)).toEqual([0, 2, 4, 5])
    expect(makeMockProjectMetricProjects(october, { page: 2, pageSize: 20 })).toMatchObject({
      page: 2,
      total: 11,
      items: []
    })
    expect(
      makeMockProjectMetricProjects({ ...october, phaseStatuses: ["开发中"] }).items.map(
        (project) => project.prjCode
      )
    ).toEqual(["T26MCB27", "T26MCB32"])
    const all = makeMockProjectMetricIndicatorExport(october).evidence.projects.map(
      ({ project }) => project
    )
    expect(all.find((project) => project.prjCode === "T26MCB28")?.notAdjustFuns).toBeNull()
    expect(all.find((project) => project.prjCode === "T26MCB29")?.devWorkHours).toBeNull()
    expect(all.find((project) => project.prjCode === "T26MCB25")?.notAdjustFuns).toBe(0)
    const november = makeMockProjectMetricOverview({
      range: { from: "2026-11-01", to: "2026-11-30" }
    })
    expect(november.code?.pushedAdoptedLines).toBe(0)
    const clock = vi.useFakeTimers()
    try {
      clock.setSystemTime(new Date("2026-11-18T09:00:00+08:00"))
      const octoberTrend = makeMockProjectMetricTrend({}).months.find(
        (month) => month.month === "2026-10"
      )
      expect(octoberTrend?.groups).toEqual(makeMockProjectMetricSummary(october).groups)
    } finally {
      vi.useRealTimers()
    }
  })
  it("五个Sheet的mock汇总可从实际依据单元格独立复算，包括跨室代码及特性去重", async () => {
    const data = makeMockProjectMetricIndicatorExport(october)
    const workbook = XLSX.read(
      await buildDashboardExcelBuffer(projectMetricIndicatorSheets(data, october)),
      { type: "buffer", cellFormula: true }
    )
    expect(workbookTable(workbook, "项目依据", "项目编号").rows).toHaveLength(12)
    expect(
      workbookTable(workbook, "代码入库依据", "统计层级").rows.find(
        (row) => row["项目模式项目编号"] === "T26MCB21" && row["代码统计组织"] === "开发二部"
      )
    ).toMatchObject({ 项目所属室: "测试 1 部", 入库代码行数: 500 })
    for (const name of ["团队指标", "各室指标"]) {
      const table = workbookTable(workbook, name, "统计组织")
      for (let i = 0; i < table.rows.length; i++) {
        const read = (column: string) =>
          workbook.Sheets[name][
            XLSX.utils.encode_cell({ r: table.startRow - 1 + i, c: table.header.indexOf(column) })
          ]
        const numerator = read("分子"),
          denominator = read("分母"),
          result = read("结果")
        if (numerator.v === "—" || denominator.v === "—") {
          expect(result.v).toBe("—")
          continue
        }
        const n = evaluateEvidenceFormula(workbook, numerator.f!)
        const d = evaluateEvidenceFormula(workbook, denominator.f!)
        expect(n).toBeCloseTo(Number(numerator.v), 8)
        expect(d).toBeCloseTo(Number(denominator.v), 8)
        const metric = String(table.rows[i]["指标"])
        const factor =
          metric === "月人均产出功能点" || metric === "月人均特性吞吐率"
            ? 152.25
            : metric === "平均缺陷密度" ||
                metric === "应用研发智能化特性占比" ||
                metric === "AI代码入库率" ||
                metric.startsWith("代码入库情况－")
              ? 100
              : 1
        if (d > 0) expect(result.v).toBeCloseTo((n * factor) / d, 8)
        else expect(result.v).toBe("—")
      }
    }
  })
})

const thirdQuarter: ProjectMetricFilters = { range: { from: "2026-07-01", to: "2026-09-30" } }
const quarterMonths = ["2026-07", "2026-08", "2026-09"]
function quarterMonthlyRows(): Doc[] {
  return quarterMonths.flatMap((timeRange, index) => [
    {
      teamName: PROJECT_METRIC_TEAM,
      timeRange,
      orgLevel: "team",
      totalPushedLines: (index + 1) * 1000,
      devagentIdePushedLines: (index + 1) ** 2 * 100,
      devagentCloudPushedLines: (index + 1) * 10,
      devagentCliPushedLines: 0
    },
    ...["A室", "B室"].map((roomName, roomIndex) => ({
      teamName: PROJECT_METRIC_TEAM,
      timeRange,
      orgLevel: "room",
      roomName,
      totalPushedLines: (index + 1 + roomIndex * 3) * 100,
      devagentIdePushedLines: (index + 1 + roomIndex * 3) * 10,
      devagentCloudPushedLines: 0,
      devagentCliPushedLines: 0
    }))
  ])
}

describe("完整自然月份区间的组织代码累计", () => {
  it("一次查询全部月份，团队和多室先累计分子分母，不平均各月比例", async () => {
    const { deps, queries } = fixture({ monthly: quarterMonthlyRows() })
    const team = await fetchProjectMetricOverview(thirdQuarter, deps)
    expect(team.monthly).toMatchObject({
      month: "2026-07 至 2026-09",
      totalPushedLines: 6000,
      sources: [
        { pushedLines: 1400, rate: 1400 / 6000 },
        { pushedLines: 60, rate: 0.01 },
        { pushedLines: 0, rate: 0 },
        { pushedLines: 100, rate: 100 / 6000 }
      ],
      cumulative: { pushedLines: 1560, rate: 0.26, missing: false }
    })
    expect(queries.filter((query) => query.index === "monthly")).toHaveLength(1)
    expect(
      (
        queries.find((query) => query.index === "monthly")!.body.query as {
          bool: { filter: unknown[] }
        }
      ).bool.filter
    ).toContainEqual({ terms: { timeRange: quarterMonths } })
    expect(deps.codeStats).toHaveBeenCalledWith(thirdQuarter.range, null, ["h-P1"])
    const rooms = await fetchProjectMetricOverview(
      { ...thirdQuarter, upperOrgLv1: ["A室", "B室"] },
      deps
    )
    expect(rooms.monthly).toMatchObject({
      totalPushedLines: 2100,
      sources: [{ pushedLines: 210, rate: 0.1 }, {}, {}, {}]
    })
  })
  it("任一月份渠道缺失或组织月份缺失均不补零，同组织同月重复仍报错", async () => {
    const partialChannel = quarterMonthlyRows().map((row) =>
      row.orgLevel === "team" && row.timeRange === "2026-08"
        ? { ...row, devagentIdePushedLines: null }
        : row
    )
    const missingChannel = await fetchProjectMetricOverview(
      thirdQuarter,
      fixture({ monthly: partialChannel }).deps
    )
    expect(missingChannel.monthly).toMatchObject({
      totalPushedLines: 6000,
      sources: [{ pushedLines: null, missing: true }, { pushedLines: 60 }, {}, {}],
      cumulative: { pushedLines: null, missing: true }
    })
    const partialMonths = quarterMonthlyRows().filter(
      (row) => row.orgLevel !== "team" || row.timeRange !== "2026-08"
    )
    const missingMonth = await fetchProjectMetricOverview(
      thirdQuarter,
      fixture({ monthly: partialMonths }).deps
    )
    expect(missingMonth.monthly).toMatchObject({
      totalPushedLines: null,
      sources: [{ pushedLines: null }, {}, {}, { pushedLines: 100, rate: null }],
      cumulative: { rate: null, missing: true }
    })
    const rows = quarterMonthlyRows()
    const duplicate = fixture({ monthly: [...rows, rows[0]] })
    expect((await fetchProjectMetricOverview(thirdQuarter, duplicate.deps)).monthlyError).toContain(
      "重复填报"
    )
    await expect(fetchProjectMetricIndicatorExport(thirdQuarter, duplicate.deps)).rejects.toThrow(
      "重复填报"
    )
  })
  it("区间含不完整月份不查询月度数据，完整多月mock按月份保留事实", async () => {
    const { deps, queries } = fixture({ monthly: quarterMonthlyRows() })
    const partial = { range: { from: "2026-07-02", to: "2026-09-30" } }
    expect((await fetchProjectMetricOverview(partial, deps)).monthly).toBeNull()
    expect(queries.some((query) => query.index === "monthly")).toBe(false)
    const mock = makeMockProjectMetricIndicatorExport(thirdQuarter)
    expect(mock.team.overview.monthly?.month).toBe("2026-07 至 2026-09")
    expect(mock.team.overview.monthly?.totalPushedLines).toBe(1055649 * 3)
    expect(
      mock.evidence.monthly.filter((row) => row.orgLevel === "team").map((row) => row.month)
    ).toEqual(quarterMonths)
  })
  it("Excel逐月保留月度依据，累计值和公式引用均覆盖全部月份", async () => {
    const { deps } = fixture({
      projects: [
        project("P1", {
          createDate: "2026-09-01 00:00:00",
          firstStStartDate: "2026-09-10 00:00:00"
        })
      ],
      monthly: quarterMonthlyRows()
    })
    const exported = await fetchProjectMetricIndicatorExport(thirdQuarter, deps)
    const sheets = projectMetricIndicatorSheets(exported, thirdQuarter)
    const workbook = XLSX.read(await buildDashboardExcelBuffer(sheets), {
      type: "buffer",
      cellFormula: true
    })
    const evidence = workbookTable(workbook, "代码入库依据", "统计层级")
    expect(
      evidence.rows
        .filter((row) => row["统计层级"] === "团队" && row["数据来源"] === "组织累计入库")
        .map((row) => row["统计周期"])
    ).toEqual(quarterMonths)
    const summary = sheets[0]
    const cumulative = summary.rows.find(
      (row) => row[1] === "代码入库情况－累计 AI 入库代码占比（硅碳比）"
    )!
    const numerator = cumulative[summary.header.indexOf("分子")]
    const denominator = cumulative[summary.header.indexOf("分母")]
    expect(typeof numerator).toBe("object")
    expect(typeof denominator).toBe("object")
    expect(evaluateEvidenceFormula(workbook, (numerator as { formula: string }).formula)).toBe(1560)
    expect(evaluateEvidenceFormula(workbook, (denominator as { formula: string }).formula)).toBe(
      6000
    )
    expect(cellValue(cumulative[summary.header.indexOf("结果")])).toBe(26)
    expect(cumulative[summary.header.indexOf("计算说明")]).toContain(
      "完整自然月 2026-07 至 2026-09"
    )
    const partial = await fetchProjectMetricIndicatorExport(
      { range: { from: "2026-07-01", to: "2026-09-29" } },
      deps
    )
    expect(partial.evidence.monthly).toHaveLength(0)
    expect(
      projectMetricIndicatorSheets(partial, thirdQuarter)[0].rows.some((row) =>
        String(row[1]).startsWith("代码入库情况－")
      )
    ).toBe(false)
  })
})
