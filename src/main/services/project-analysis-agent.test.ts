import {
  mockStreamingModel,
  TEST_PROJECT_BUDGET,
  testReviewer,
  type MockModelInvoke
} from "./project-analysis/streaming-model-test-fixture"
import { describe, expect, it, vi } from "vitest"
import { AIMessage, ToolMessage } from "@langchain/core/messages"
import type { ProjectAnalysisAgentInput } from "../../shared/project-analysis-agent"
import { DEFAULT_RUN_ANALYSIS_FILTERS } from "../../shared/project-run-analysis-metrics"
import { makeMockRunAnalysis } from "../ipc/project-run-analysis-mock"
vi.mock("../models/registry", () => ({ getDefaultModelConfig: () => null }))
vi.mock("../models/connection", () => ({ getModelClientOptions: () => ({}) }))
import {
  parseProjectAnalysisInput,
  runProjectAnalysisAgent,
  selectProjectAnalysisRows,
  type ProjectAnalysisDependencies
} from "./project-analysis-agent"

const range = { from: "2026-01-01T00:00:00Z", to: "2026-12-31T23:59:59Z" }
const data = makeMockRunAnalysis(range)
const input: ProjectAnalysisAgentInput = {
  question: "哪些特性值得关注",
  range,
  options: { upperOrgLv1: ["本室"], membership: "active", fromLeanOnly: true },
  filters: DEFAULT_RUN_ANALYSIS_FILTERS
}
const answer = () => new AIMessage("当前筛选包含 12 个项目 [E1]。请核实未提交原因。")
function harness(responses: Array<AIMessage | Error> = [answer()]) {
  const invoke = vi.fn<MockModelInvoke>(async () => {
    const next = responses.shift() ?? answer()
    if (next instanceof Error) throw next
    return next
  })
  const final = vi.fn(async () => answer())
  const reviewed: string[] = []
  const deps: ProjectAnalysisDependencies = {
    loadData: vi.fn(async () => data),
    loadStages: vi.fn(async () => ({ rows: [], dataAsOf: data.dataAsOf })),
    loadSessions: vi.fn(async () => ({ rows: [], total: 0, after: null })),
    createModel: () => ({
      name: "test-model",
      budget: TEST_PROJECT_BUDGET,
      reviewer: testReviewer((messages) =>
        reviewed.push(messages.map((m) => String(m.content)).join("\n"))
      ),
      agent: mockStreamingModel({ invoke }),
      final: mockStreamingModel({ invoke: final })
    })
  }
  return { deps, invoke, final, reviewed }
}
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: "c1", name, args, type: "tool_call" }] })

describe("project analysis agent", () => {
  it("validates filters and refuses client-supplied data or malformed scope", () => {
    expect(() =>
      parseProjectAnalysisInput({ ...input, panelSnapshot: { projectCount: 999 } })
    ).toThrow("参数无效")
    expect(() =>
      parseProjectAnalysisInput({ ...input, range: { from: "bad", to: "bad" } })
    ).toThrow("日期")
    expect(() =>
      parseProjectAnalysisInput({
        ...input,
        filters: {
          ...input.filters,
          numeric: { tools: { operator: "between", value: 10, upper: 1 } }
        }
      })
    ).toThrow("下限")
    expect(() =>
      parseProjectAnalysisInput({ ...input, filters: { ...input.filters, plugin: "{}" } })
    ).toThrow("插件")
  })
  it("uses server data and the same complete filter selection as the UI", async () => {
    const h = harness()
    const request: ProjectAnalysisAgentInput = {
      ...input,
      filters: { ...input.filters, numeric: { noSkill: { operator: "lt", value: 19 } } }
    }
    const result = await runProjectAnalysisAgent(request, h.deps)
    const rows = selectProjectAnalysisRows(data, request)
    expect(h.deps.loadData).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(result.featureCount).toBe(rows.filter((r) => r.featureSlug !== null).length)
    const system = String(h.invoke.mock.calls[0][0][0].content)
    const facts = JSON.parse(system.split("\n").at(-1)!)
    const adopted = rows.reduce((n, r) => n + (r.codeStats?.adoptedLines ?? 0), 0)
    expect(facts.overview.code.adoptedLines).toBe(adopted)
    expect(system).toContain("累计")
    expect(result.evidence[0].id).toBe("E1")
  })
  it("limits a feature target by project ID as well as slug", async () => {
    const row = data.rows[1]
    const h = harness()
    const result = await runProjectAnalysisAgent(
      { ...input, target: { projectId: row.projectId, featureSlug: row.featureSlug } },
      h.deps
    )
    expect(result.projectCount).toBe(1)
    expect(result.featureCount).toBe(1)
    expect(selectProjectAnalysisRows(data, { ...input, target: { projectId: "outside" } })).toEqual(
      []
    )
    await expect(
      runProjectAnalysisAgent({ ...input, target: { projectId: "outside" } }, h.deps)
    ).rejects.toThrow("没有可分析")
  })
  it("does not let a model escape filters or inject another room into detail tools", async () => {
    const row = data.rows[1]
    const h = harness([
      call("feature_stages", { projectId: "outside", featureSlug: row.featureSlug }),
      call("feature_stages", {
        projectId: row.projectId,
        featureSlug: row.featureSlug,
        upperOrgLv1: "其他室"
      }),
      answer()
    ])
    const result = await runProjectAnalysisAgent(input, h.deps)
    expect(h.deps.loadStages).not.toHaveBeenCalled()
    expect(result.toolCalls.map((t) => t.success)).toEqual([false, false])
    expect(h.invoke.mock.calls.at(-1)![0].filter((m) => m instanceof ToolMessage)).toHaveLength(2)
  })
  it("uses verified scope for detail queries and returns evidence targets", async () => {
    const row = data.rows[1]
    const h = harness([
      call("feature_stages", { projectId: row.projectId, featureSlug: row.featureSlug }),
      answer()
    ])
    const result = await runProjectAnalysisAgent(input, h.deps)
    expect(h.deps.loadStages).toHaveBeenCalledWith(
      { ...input.options, projectId: row.projectId, featureSlug: row.featureSlug },
      expect.any(AbortSignal)
    )
    expect(result.evidence[1].target).toEqual({
      projectId: row.projectId,
      featureSlug: row.featureSlug
    })
  })
  it("can query beyond the first UI page with bounded responses and evidence", async () => {
    const h = harness([
      call("project_analysis", { sort: "noSkill", descending: true, offset: 20, limit: 20 }),
      answer()
    ])
    const result = await runProjectAnalysisAgent(input, h.deps)
    const msg = h.invoke.mock.calls[1][0].find((m) => m instanceof ToolMessage)!
    const payload = JSON.parse(String(msg.content))
    expect(payload.total).toBe(36)
    expect(payload.rows.length).toBeGreaterThan(0)
    expect(payload.rows.length).toBeLessThanOrEqual(16)
    expect(payload.nextOffset).toBe(payload.rows.length === 16 ? null : 20 + payload.rows.length)
    expect(result.evidence).toHaveLength(1 + payload.rows.length)
  })
  it("falls back to verified facts when a provider rejects tools or returns empty text", async () => {
    const h = harness([Object.assign(new Error("unsupported tools"), { status: 400 })])
    expect((await runProjectAnalysisAgent(input, h.deps)).content).toContain("[E1]")
    expect(h.final).toHaveBeenCalledTimes(1)
    const empty = harness([new AIMessage("")])
    await runProjectAnalysisAgent(input, empty.deps)
    expect(empty.final).toHaveBeenCalledTimes(1)
  })
  it("repairs malformed tool calls without putting invalid calls into subsequent messages", async () => {
    const bad = new AIMessage({
      content: "",
      invalid_tool_calls: [
        {
          id: "bad",
          name: "feature_stages",
          args: "{broken",
          error: "JSON",
          type: "invalid_tool_call"
        }
      ]
    })
    const h = harness([bad, answer()])
    await runProjectAnalysisAgent(input, h.deps)
    expect(h.invoke.mock.calls[1][0]).not.toContain(bad)
  })
  it("stops promptly on cancellation and does not execute tools returned afterwards", async () => {
    const h = harness()
    const controller = new AbortController()
    h.deps.signal = controller.signal
    h.invoke.mockImplementationOnce(async () => {
      controller.abort()
      return call("feature_stages", {
        projectId: data.rows[0].projectId,
        featureSlug: data.rows[0].featureSlug
      })
    })
    await expect(runProjectAnalysisAgent(input, h.deps)).rejects.toThrow()
    expect(h.deps.loadStages).not.toHaveBeenCalled()
  })
  it("discards text returned after cancellation, including the fallback response", async () => {
    for (const fallback of [false, true]) {
      const h = harness(fallback ? [new AIMessage("")] : [])
      const controller = new AbortController()
      h.deps.signal = controller.signal
      const cancelledAnswer = async () => {
        controller.abort()
        return answer()
      }
      if (fallback) h.final.mockImplementationOnce(cancelledAnswer)
      else h.invoke.mockImplementationOnce(cancelledAnswer)
      await expect(runProjectAnalysisAgent(input, h.deps)).rejects.toThrow()
    }
  })
  it("bounds tool batches and supplies matching IDs for providers that omit them", async () => {
    const oversized = new AIMessage({
      content: "",
      tool_calls: Array.from({ length: 13 }, () => ({
        name: "project_analysis",
        args: { view: "overview" }
      }))
    })
    const noId = new AIMessage({
      content: "",
      tool_calls: [{ name: "project_analysis", args: { view: "overview" } }]
    })
    const h = harness([oversized, noId, answer()])
    const result = await runProjectAnalysisAgent(input, h.deps)
    expect(result.toolCalls).toEqual([{ name: "project_analysis", success: true }])
    expect(h.invoke.mock.calls[2][0]).not.toContain(oversized)
    const toolMessage = h.invoke.mock.calls[2][0].find((m) => m instanceof ToolMessage)!
    const assistantMessage = h.invoke.mock.calls[2][0].find(
      (m) => m instanceof AIMessage && m.tool_calls?.length === 1
    ) as AIMessage
    expect(assistantMessage.tool_calls![0].id).toBeTruthy()
    expect(toolMessage.tool_call_id).toBe(assistantMessage.tool_calls![0].id)
  })
  it("reports missing model setup and authentication failures in actionable language", async () => {
    const h = harness()
    h.deps.createModel = undefined
    await expect(runProjectAnalysisAgent(input, h.deps)).rejects.toThrow("默认模型")
    const auth = harness([Object.assign(new Error("secret provider details"), { status: 401 })])
    await expect(runProjectAnalysisAgent(input, auth.deps)).rejects.toThrow("认证")
  })
  it("includes the complete page dataset and diagnoses all matching rows with user thresholds", async () => {
    const h = harness([call("diagnose_projects", { thresholds: { idleDays: 7 } }), answer()])
    const result = await runProjectAnalysisAgent(input, h.deps)
    const prompt = h.invoke.mock.calls[0][0].map((message) => String(message.content)).join("\n")
    expect(prompt).toContain(data.rows.at(-1)!.projectId)
    expect(h.reviewed.join("\n")).toContain(data.rows.at(-1)!.projectId)
    expect(h.reviewed.join("\n")).toContain("creator")
    expect(prompt).not.toContain('"values":')
    const reply = h.invoke.mock.calls[1][0].find((message) => message instanceof ToolMessage)!
    const facts = JSON.parse(String(reply.content))
    expect(facts.examinedFeatures).toBe(data.rows.length)
    expect(facts.thresholds.idleDays).toBe(7)
    expect(
      result.evidence.some((item) => item.label.includes("异常候选") && item.target?.projectId)
    ).toBe(true)
  })
  it("restricts project-list tools and diagnostic scanning to the selected target", async () => {
    const row = data.rows[3]
    const h = harness([
      call("project_list", { projectIds: ["outside"] }),
      call("diagnose_projects", {}),
      answer()
    ])
    h.deps.loadProjects = vi.fn(async () => [])
    await runProjectAnalysisAgent(
      { ...input, target: { projectId: row.projectId, featureSlug: row.featureSlug } },
      h.deps
    )
    expect(h.deps.loadProjects).not.toHaveBeenCalled()
    const replies = h.invoke.mock.calls
      .at(-1)![0]
      .filter((message) => message instanceof ToolMessage)
    expect(JSON.parse(String(replies[1].content)).examinedFeatures).toBe(1)
  })
  it("keeps project-list feature detail inside the selected target while labeling whole-project backgrounds", async () => {
    const row = data.rows[1]
    const h = harness([
      call("project_list", { view: "features", projectIds: [row.projectId] }),
      answer()
    ])
    h.deps.loadProjects = vi.fn(async () => [
      {
        projectId: row.projectId,
        name: row.projectName,
        features: [
          { slug: row.featureSlug, title: row.featureTitle },
          { slug: "hidden-by-current-filter", title: "范围外特性" }
        ]
      }
    ])
    await runProjectAnalysisAgent(
      { ...input, target: { projectId: row.projectId, featureSlug: row.featureSlug } },
      h.deps
    )
    const message = h.invoke.mock.calls[1][0].find((m) => m instanceof ToolMessage)!
    const result = JSON.parse(String(message.content))
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].slug).toBe(row.featureSlug)
    expect(result.basis).toContain("项目级累计")
  })
})
