import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { DEFAULT_RUN_ANALYSIS_FILTERS } from "../../../shared/project-run-analysis-metrics"
import type { ProjectAgentRunEvent } from "../../../shared/project-agent-run"
import type { ProjectReportScope } from "../../../shared/project-analysis-report"
import { makeMockRunAnalysis } from "../../ipc/project-run-analysis-mock"
import { estimateProjectTokens, projectContextBudget } from "./context-budget"
import { generateProjectReport } from "./report-agent"
import { buildReportSnapshot } from "./report-data"
import { makeReportPeriodExample } from "./report-mock"
import { projectListPageData } from "./page-data"
import { createProjectRunReporter } from "./run-progress"
import { runProjectAnalysisAgent } from "../project-analysis-agent"
import { recommendedReportTemplate } from "./report-builtin-template"

const settings = vi.hoisted(() => ({
  config: {
    model: "configured-default-model",
    apiKey: "local-sse-test",
    baseUrl: "",
    maxTokens: 0,
    maxOutputTokens: 0
  }
}))
vi.mock("../../models/registry", () => ({ getDefaultModelConfig: () => settings.config }))
vi.mock("../../models/connection", () => ({
  getModelClientOptions: (config: { baseUrl: string }) => ({
    configuration: { baseURL: config.baseUrl }
  })
}))

interface RequestBody {
  model: string
  stream: boolean
  max_tokens: number
  tools?: object[]
  messages: Array<{ role: string; content: string; tool_calls?: object[]; tool_call_id?: string }>
}
const html = (heading: string) =>
  `<!doctype html><html><head><style>body{font:16px sans-serif}</style></head><body><h1>${heading}</h1><p data-report-value="summary.projectCount"></p><p data-report-value="knowledge.window"></p><table><tbody><tr data-report-repeat="members"><td data-report-value="name"></td><td data-report-value="generatedLines"></td></tr></tbody></table><p data-report-insight>请核实待关注项目。</p></body></html>`

describe("project Agent workflows with the configured default model over real SSE", () => {
  it.each([
    [32_768, 4096],
    [65_536, 12_288]
  ])(
    "runs analysis, report generation and revision with context=%s/output=%s",
    async (contextTokens, outputTokens) => {
      settings.config.maxTokens = contextTokens
      settings.config.maxOutputTokens = outputTokens
      const budget = projectContextBudget(settings.config)
      const range = { from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }
      const analysis = makeMockRunAnalysis(range)
      const projects = [
        ...new Map(
          analysis.rows.map((row) => [
            row.projectId,
            {
              projectId: row.projectId,
              name: row.projectName,
              description: "页面可见完整背景".repeat(150),
              features: []
            }
          ])
        ).values()
      ]
      const requests: RequestBody[] = []
      const reviewBodies: string[] = []
      const events: ProjectAgentRunEvent[] = []
      let phase: "analysis" | "report" | "revise" = "analysis"
      let round = 0
      let repaired = false
      let revisionSawOriginal = false
      const server = createServer(async (req, res) => {
        let raw = ""
        for await (const chunk of req) raw += chunk.toString()
        const body = JSON.parse(raw) as RequestBody
        requests.push(body)
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
        const send = (delta: object, finish: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: settings.config.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
          )
        const system = body.messages[0].content
        const isReview = system.includes("你在完整审阅") || system.includes("你在压缩")
        if (isReview) {
          reviewBodies.push(body.messages.map((m) => m.content).join("\n"))
          send({ role: "assistant", content: "本批已审阅。" })
          send({ content: "阶段是当前快照，累计指标不当作周期增量；完整明细可回查。" }, "stop")
        } else if (!body.tools?.length) {
          repaired = true
          send({ role: "assistant", content: html("本室综合报告") }, "stop")
        } else {
          if (phase === "revise" && round === 0)
            revisionSawOriginal = body.messages.some(
              (m) => m.content?.includes("修改已有报告") && m.content.includes("本室综合报告")
            )
          const projectQuery = { name: "project_analysis", args: { view: "features", limit: 20 } }
          const listQuery = { name: "project_list", args: { view: "projects", limit: 20 } }
          if (round < 2) {
            const stored = body.messages
              .filter((m) => m.role === "tool")
              .map((m) => {
                try {
                  return JSON.parse(m.content)
                } catch {
                  return {}
                }
              })
              .find((r) => r.storedResult)
            const third =
              round === 1 && stored
                ? {
                    name: "read_context",
                    args: { resultId: stored.storedResult, path: ["rows", "0"] }
                  }
                : phase === "analysis"
                  ? { name: "diagnose_projects", args: {} }
                  : { name: "report_data", args: { section: "features" } }
            const calls = [projectQuery, listQuery, third]
            send({
              role: "assistant",
              tool_calls: calls.map((c, i) => ({
                index: i,
                id: `q${round}-${i}`,
                type: "function",
                function: { name: c.name, arguments: "" }
              }))
            })
            // Exercise streamed argument assembly, not a mocked model.invoke.
            send(
              {
                tool_calls: calls.map((c, i) => ({
                  index: i,
                  function: { arguments: JSON.stringify(c.args) }
                }))
              },
              "tool_calls"
            )
          } else {
            const answer =
              phase === "analysis"
                ? "开发示例数据：已检查当前范围，建议核实采纳率 [E1]。"
                : phase === "revise"
                  ? html("精简版综合报告")
                  : html("本室综合报告").slice(0, -7)
            send({ role: "assistant", content: answer.slice(0, 45) })
            send({ content: answer.slice(45) }, "stop")
          }
          round++
        }
        res.end("data: [DONE]\n\n")
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      settings.config.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      try {
        const answer = await runProjectAnalysisAgent(
          {
            question: "诊断全部项目并分析单个项目的指标",
            range,
            options: { upperOrgLv1: ["开发一室"], membership: "active" },
            filters: DEFAULT_RUN_ANALYSIS_FILTERS
          },
          {
            loadData: async () => analysis,
            loadProjects: async () => projects,
            loadStages: async () => ({ rows: [], dataAsOf: analysis.dataAsOf }),
            loadSessions: async () => ({ rows: [], total: 0, after: null }),
            exampleData: true,
            onEvent: (e) => events.push(e)
          }
        )
        expect(answer.content).toContain("已检查当前范围")
        expect(answer.toolCalls).toHaveLength(6)
        expect(answer.toolCalls.every((c) => c.success)).toBe(true)
        expect(answer.modelName).toBe(settings.config.model)
        expect(reviewBodies.join("\n")).toContain(analysis.rows.at(-1)!.projectId)

        const scope: ProjectReportScope = {
          upperOrgLv1: "开发一室",
          period:
            contextTokens === 32_768
              ? { kind: "week", anchorDate: "2026-10-27" }
              : { kind: "month", month: "2026-10" }
        }
        const snapshot = buildReportSnapshot({
          scope,
          data: makeReportPeriodExample(scope),
          accumulation: null,
          active: null,
          knowledgeAsOf: "2026-11-12T00:00:00Z",
          exampleData: true
        })
        snapshot.pageData = projectListPageData(projects, analysis)
        const frozen = JSON.stringify(snapshot)
        phase = "report"
        round = 0
        const report = await generateProjectReport({
          snapshot,
          template: recommendedReportTemplate(),
          instruction: "列出所有成员产出及待关注项目",
          progress: createProjectRunReporter((e) => events.push(e))
        })
        expect(report.html).toContain("本室综合报告")
        expect(report.html).toContain(String(snapshot.facts.members.at(-1)!.name))
        expect(report.html).toContain("近30天")
        expect(repaired).toBe(true)
        expect(reviewBodies.join("\n")).toContain(projects.at(-1)!.name)
        expect(report.reviewNote).toContain("项目分析 36条")
        expect(report.modelName).toBe(settings.config.model)
        expect(
          requests.some((r) =>
            r.messages.some((m) => m.content?.includes("内置推荐：室级综合运营报告"))
          )
        ).toBe(true)

        phase = "revise"
        round = 0
        const revised = await generateProjectReport({
          snapshot,
          previousSource: report.source,
          instruction: "保留全部成员数据，标题改成精简版综合报告",
          progress: createProjectRunReporter((e) => events.push(e))
        })
        expect(revised.html).toContain("精简版综合报告")
        expect(revised.html).toContain(String(snapshot.facts.members.at(-1)!.name))
        expect(revisionSawOriginal).toBe(true)
        // The only allowed snapshot mutation is initializing the frozen session cache.
        delete snapshot.pageData.sessions
        expect(JSON.stringify(snapshot)).toBe(frozen)
        expect(requests.length).toBeGreaterThan(10)
        for (const request of requests) {
          expect(request.stream).toBe(true)
          expect(request.model).toBe(settings.config.model)
          expect(request.max_tokens).toBe(outputTokens)
          expect(
            estimateProjectTokens(JSON.stringify(request.messages)) +
              estimateProjectTokens(JSON.stringify(request.tools ?? []))
          ).toBeLessThan(budget.inputTokens)
        }
        expect(
          events.some((e) => e.type === "step" && e.step.detail?.includes("复用已有查询"))
        ).toBe(true)
        expect(events.some((e) => e.type === "text" && e.text.includes("已检查"))).toBe(true)
        expect(
          requests.some((r) =>
            r.messages.some((m) => m.role === "tool" && m.content?.includes("storedResult"))
          )
        ).toBe(true)
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
    30_000
  )
})
