import { describe, expect, it, vi } from "vitest"
import type { RunAnalysisFeature, RunAnalysisSessions } from "../../../shared/project-run-analysis"
import { makeMockRunAnalysis, makeMockRunAnalysisStages } from "../../ipc/project-run-analysis-mock"
import { projectListPageData } from "./page-data"
import { createProjectTools, type ProjectToolOptions } from "./project-tools"

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-31T23:59:59Z" }
function setup() {
  const data = makeMockRunAnalysis(range)
  const makeRow = (
    projectId: string,
    slug: string,
    generated: number,
    adopted: number
  ): RunAnalysisFeature => ({
    ...data.rows[0],
    projectId,
    projectName: projectId === "p1" ? "支付系统" : "账户系统",
    featureSlug: slug,
    toolCalls: projectId === "p1" ? null : 8,
    conversationCount: generated,
    noSkillConversationCount: 0,
    lastExecutedAt: data.dataAsOf,
    executionSpanMs: 100,
    vibeAdoptedShare: 0,
    codeStats: {
      ...data.rows[0].codeStats!,
      generatedLines: generated,
      effectiveGeneratedLines: generated,
      measuredGeneratedLines: generated,
      deletedLines: 0,
      unmeasuredGeneratedLines: 0,
      inclusiveEffectiveGeneratedLines: generated,
      adoptedLines: adopted,
      inclusiveAdoptionRate: adopted / generated,
      measuredAdoptionRate: adopted / generated,
      adoptionRate: adopted / generated
    }
  })
  data.rows = [
    makeRow("p1", "f1", 100, 90),
    makeRow("p1", "f2", 900, 90),
    makeRow("p2", "f1", 100, 80)
  ]
  data.projectCount = 2
  data.featureCount = 3
  const pages = projectListPageData(
    [
      {
        projectId: "p1",
        name: "支付系统",
        conversationCount: 8888,
        workspacePath: "/private",
        features: [{ slug: "f1" }, { slug: "f2" }]
      },
      { projectId: "p2", name: "账户系统", conversationCount: 100, features: [{ slug: "f1" }] },
      { projectId: "archived", name: "归档项目", lifecycleStatus: "archived" }
    ],
    data
  )
  const options: ProjectToolOptions = {
    analysis: data,
    projectIds: ["p1", "p2", "archived"],
    getPages: vi.fn(async () => pages),
    stages: pages.stages,
    sessions: {},
    signal: new AbortController().signal
  }
  const tools = createProjectTools(options)
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(String(await tools.find((tool) => tool.name === name)!.invoke(args)))
  return { options, data, pages, tools, call }
}

describe("shared project analysis tools", () => {
  it("locates projects by page fields, keeps project totals separate and computes weighted comparisons", async () => {
    const s = setup()
    const list = await s.call("project_list", { keyword: "支付" })
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ projectId: "p1", conversationCount: 8888 })
    expect(list.rows[0]).not.toHaveProperty("workspacePath")
    const single = await s.call("project_analysis", { view: "overview", projectIds: ["p1"] })
    expect(single).toMatchObject({
      projectCount: 1,
      featureCount: 2,
      conversations: 1000,
      toolCalls: null,
      code: { inclusiveAdoptionRate: 0.18, pushedCommitCount: null }
    })
    const comparison = await s.call("project_analysis", {
      view: "projects",
      projectIds: ["p1", "p2"],
      sort: "adoption",
      descending: false
    })
    expect(comparison.rows.map((row: { projectId: string }) => row.projectId)).toEqual(["p1", "p2"])
    expect(comparison.rows[0]).toMatchObject({
      featureCount: 2,
      summary: { code: { inclusiveAdoptionRate: 0.18 } }
    })
    expect(comparison.rows[0]).not.toHaveProperty("featureSlug")
    expect(comparison.rows[1].summary.code.inclusiveAdoptionRate).toBe(0.8)
    const projectFilter = await s.call("project_analysis", {
      view: "projects",
      conditions: [{ metric: "adoptionRate", operator: "lt", value: 0.15 }]
    })
    // p1 has a 10% feature but its weighted project rate is 18%, so it must not match.
    expect(projectFilter.total).toBe(0)
    const matchingProject = await s.call("project_analysis", {
      view: "projects",
      conditions: [{ metric: "adoptionRate", operator: "lte", value: 0.2 }]
    })
    expect(matchingProject).toMatchObject({ total: 1, matchedRows: 2 })
    expect(matchingProject.rows[0].summary.code.inclusiveAdoptionRate).toBe(0.18)
    await expect(s.call("project_analysis", { view: "projects", stage: "dev" })).rejects.toThrow(
      "没有单一阶段"
    )
  })
  it("narrows within the existing scope using numeric conditions and never silently discards invalid conditions", async () => {
    const s = setup()
    const filtered = await s.call("project_analysis", {
      view: "features",
      conditions: [
        { metric: "adoptionRate", operator: "lte", value: 0.3 },
        { metric: "tools", operator: "missing" }
      ]
    })
    expect(filtered).toMatchObject({ availableRows: 3, matchedRows: 1, total: 1 })
    expect(filtered.rows[0]).toMatchObject({
      projectId: "p1",
      featureSlug: "f2",
      conversationCount: 900,
      codeStats: { inclusiveAdoptionRate: 0.1 }
    })
    await expect(s.call("project_analysis", { projectIds: ["outside"] })).rejects.toThrow(
      "权限范围"
    )
    await expect(s.call("project_list", { projectIds: ["outside"] })).rejects.toThrow("权限范围")
    expect(s.options.getPages).not.toHaveBeenCalled()
    await expect(s.call("project_analysis", { featureSlug: "f1" })).rejects.toThrow("唯一项目")
    await expect(
      s.call("project_analysis", { projectIds: ["p2"], featureSlug: "f2" })
    ).rejects.toThrow("特性不在")
    await expect(
      s.call("project_analysis", {
        conditions: [{ metric: "adoptionRate", operator: "lte", value: 30 }]
      })
    ).rejects.toThrow("有效数值")
    await expect(
      s.call("project_analysis", {
        conditions: [{ metric: "tools", operator: "between", value: 9, upper: 2 }]
      })
    ).rejects.toThrow("下限")
    await expect(
      s.call("project_analysis", { conditions: [{ metric: "tools", operator: "lt" }] })
    ).rejects.toThrow("需要value")
    await expect(
      s.call("project_analysis", {
        conditions: [
          { metric: "tools", operator: "lt", value: 8 },
          { metric: "tools", operator: "gt", value: 2 }
        ]
      })
    ).rejects.toThrow("只设置一个")
  })
  it("reports missing analysis for list-only projects and scopes diagnostic totals and rules to a single project", async () => {
    const s = setup()
    const missing = await s.call("project_analysis", { view: "overview", projectIds: ["archived"] })
    expect(missing).toMatchObject({
      projectsWithoutAnalysis: ["archived"],
      availableRows: 0,
      code: null
    })
    const selected = await s.call("diagnose_projects", {
      projectIds: ["p1"],
      rules: ["adoption"],
      thresholds: { adoptionRate: 0.2 }
    })
    expect(selected).toMatchObject({
      examinedProjects: 1,
      examinedFeatures: 2,
      candidateProjects: 1,
      total: 1,
      unknown: { toolCalls: 2 },
      rules: ["adoption"]
    })
    expect(selected.rows[0]).toMatchObject({
      projectId: "p1",
      featureSlug: "f2",
      signals: [{ rule: "adoption", observed: { adoptionRate: 0.1 } }]
    })
    const other = await s.call("diagnose_projects", { projectIds: ["p2"], rules: ["adoption"] })
    expect(other).toMatchObject({
      examinedProjects: 1,
      examinedFeatures: 1,
      candidateProjects: 0,
      unknown: { toolCalls: 0 }
    })
  })
  it("paginates every stage including those beyond 40, caches results and rejects out-of-scope drilling", async () => {
    const s = setup()
    s.options.loadStages = vi.fn(async () => ({
      dataAsOf: s.data.dataAsOf,
      rows: Array.from({ length: 57 }, (_, i) => ({
        ...makeMockRunAnalysisStages()[0],
        nodeName: `stage-${i}`,
        conversationCount: 57 - i
      }))
    }))
    const names: string[] = []
    let offset: number | null = 0
    do {
      const page = await s.call("feature_stages", { projectId: "p1", featureSlug: "f1", offset })
      expect(page.total).toBe(57)
      names.push(...page.rows.map((row: { nodeName: string }) => row.nodeName))
      offset = page.nextOffset
    } while (offset !== null)
    expect(names).toEqual(Array.from({ length: 57 }, (_, i) => `stage-${i}`))
    expect(s.options.loadStages).toHaveBeenCalledTimes(1)
    await expect(s.call("feature_stages", { projectId: "p2", featureSlug: "f2" })).rejects.toThrow(
      "特性不在"
    )
    expect(s.options.loadStages).toHaveBeenCalledTimes(1)
  })
  it("walks all session pages without losing rows 21–50 and binds opaque cursors to their original query", async () => {
    const s = setup()
    const sessions = Array.from({ length: 61 }, (_, i) => ({
      traceId: `t${i}`,
      threadId: null,
      startedAt: null,
      endedAt: null,
      durationMs: i,
      nodeName: null,
      userName: null,
      usedSkills: []
    }))
    s.options.loadSessions = vi.fn(
      async (request): Promise<RunAnalysisSessions> => ({
        rows: request.after ? sessions.slice(50) : sessions.slice(0, 50),
        total: 61,
        after: request.after ? null : ["time", "t49"]
      })
    )
    const args = { projectId: "p1", featureSlug: "f1", metric: "noSkill", nodeName: null }
    const first = await s.call("feature_sessions", args)
    expect(first.rows).toHaveLength(20)
    await expect(s.call("feature_sessions", { ...args, cursor: "made-up" })).rejects.toThrow(
      "游标无效"
    )
    await expect(
      s.call("feature_sessions", { ...args, projectId: "p2", cursor: first.nextCursor })
    ).rejects.toThrow("不属于此查询")
    await expect(
      s.call("feature_sessions", { ...args, nodeName: undefined, cursor: first.nextCursor })
    ).rejects.toThrow("不属于此查询")
    const seen = first.rows.map((row: { traceId: string }) => row.traceId)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await s.call("feature_sessions", { ...args, cursor })
      seen.push(...page.rows.map((row: { traceId: string }) => row.traceId))
      cursor = page.nextCursor
    }
    expect(seen).toEqual(sessions.map((row) => row.traceId))
    expect(s.options.loadSessions).toHaveBeenCalledTimes(2)
    expect(s.options.loadSessions).toHaveBeenLastCalledWith(
      { ...args, after: ["time", "t49"] },
      expect.any(AbortSignal)
    )
    // Serialized caches can be replayed by a report revision without any live loader.
    const frozen = createProjectTools({
      ...s.options,
      sessions: JSON.parse(JSON.stringify(s.options.sessions)),
      loadSessions: undefined
    })
    const query = frozen.find((tool) => tool.name === "feature_sessions")!
    const replay: string[] = []
    cursor = undefined
    do {
      const page = JSON.parse(
        String(await query.invoke({ ...args, ...(cursor ? { cursor } : {}) }))
      )
      replay.push(...page.rows.map((row: { traceId: string }) => row.traceId))
      cursor = page.nextCursor
    } while (cursor)
    expect(replay).toEqual(seen)
    await expect(query.invoke({ ...args, metric: "main" })).rejects.toThrow("不刷新冻结数据")
    expect(s.options.loadSessions).toHaveBeenCalledTimes(2)
  })
  it("does not execute new detail queries after cancellation", async () => {
    const s = setup()
    const controller = new AbortController()
    controller.abort()
    s.options.signal = controller.signal
    s.options.loadSessions = vi.fn()
    s.options.loadStages = vi.fn()
    await expect(
      s.call("feature_sessions", { projectId: "p1", featureSlug: "f1" })
    ).rejects.toThrow()
    await expect(s.call("feature_stages", { projectId: "p1", featureSlug: "f1" })).rejects.toThrow()
    expect(s.options.loadSessions).not.toHaveBeenCalled()
    expect(s.options.loadStages).not.toHaveBeenCalled()
  })
})
