import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { describe, expect, it, vi } from "vitest"
import { makeMockRunAnalysis } from "../../ipc/project-run-analysis-mock"
import type { ProjectAgentRunEvent } from "../../../shared/project-agent-run"
import { ProjectModelCheckpoint, type ProjectModelCheckpointState } from "./model-checkpoint"
import { createProjectRunReporter } from "./run-progress"
import { generateProjectReport } from "./report-agent"
import { buildReportSnapshot } from "./report-data"
import { makeReportPeriodExample } from "./report-mock"
import { projectListPageData } from "./page-data"
import { projectContextBudget } from "./context-budget"
import { mockStreamingModel, testReviewer } from "./streaming-model-test-fixture"

vi.mock("../../models/registry", () => ({ getDefaultModelConfig: () => null }))
vi.mock("../../models/connection", () => ({ getModelClientOptions: () => ({}) }))

describe("report continuation from private checkpoints", () => {
  it("survives two restarts without re-reviewing completed batches or refetching cached details", async () => {
    const scope = {
      upperOrgLv1: "开发一室",
      period: { kind: "week" as const, anchorDate: "2026-10-27" }
    }
    const analysis = makeMockRunAnalysis({
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z"
    })
    // Only the first two projects had activity in this period.
    for (const row of analysis.rows)
      row.projectId = row.projectId.replace(/^demo-([01])$/, "example-project-$1")
    let snapshot = buildReportSnapshot({
      scope,
      data: makeReportPeriodExample(scope),
      accumulation: null,
      active: null,
      knowledgeAsOf: "2026-11-12T00:00:00Z",
      exampleData: true
    })
    snapshot.pageData = projectListPageData(
      [
        ...new Map(
          analysis.rows.map((row) => [
            row.projectId,
            {
              projectId: row.projectId,
              name: row.projectName,
              description: "项目完整背景数据".repeat(500),
              features: []
            }
          ])
        ).values()
      ],
      analysis
    )
    let state: ProjectModelCheckpointState = { completed: {} }
    let persisted = ""
    let phase = 0
    const reviewed: string[] = []
    const reviewer = testReviewer((messages) => {
      const text = String(messages.at(-1)?.content)
      if (phase === 0 && text.includes("本批2/")) throw new Error("审阅连接失败")
      reviewed.push(text)
    })
    const agentCall = vi.fn(async (messages: BaseMessage[]) => {
      if (!messages.some((message) => message.getType() === "tool"))
        return new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "feature_stages",
              id: "stage",
              args: {
                projectId: analysis.rows[0].projectId,
                featureSlug: analysis.rows[0].featureSlug
              }
            },
            {
              name: "feature_sessions",
              id: "sessions",
              args: {
                projectId: analysis.rows[0].projectId,
                featureSlug: analysis.rows[0].featureSlug
              }
            },
            { name: "report_data", id: "period", args: { section: "members" } }
          ]
        })
      const sessions = messages.filter(
        (message) =>
          message.getType() === "tool" && "name" in message && message.name === "feature_sessions"
      )
      if (sessions.length === 1) {
        const first = JSON.parse(String(sessions[0].content))
        return new AIMessage({
          content: "",
          tool_calls: [
            {
              name: "feature_sessions",
              id: "next-sessions",
              args: {
                projectId: analysis.rows[0].projectId,
                featureSlug: analysis.rows[0].featureSlug,
                cursor: first.nextCursor
              }
            }
          ]
        })
      }
      if (phase < 2) throw new Error("HTML生成连接失败")
      return new AIMessage(
        '<html><body><h1>续跑后的报告</h1><p data-report-value="summary.projectCount"></p></body></html>'
      )
    })
    const agent = mockStreamingModel({ invoke: agentCall })
    const loadStages = vi.fn(async () => ({ rows: [], dataAsOf: analysis.dataAsOf }))
    const loadSessions = vi.fn(async () => ({
      rows: Array.from({ length: 21 }, (_, i) => ({
        traceId: `trace-${i}`,
        threadId: null,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        nodeName: null,
        userName: null,
        usedSkills: []
      })),
      total: 21,
      after: null
    }))
    const events: ProjectAgentRunEvent[] = []
    const generate = () =>
      generateProjectReport({
        snapshot,
        instruction: "检查所有项目，生成综合报告",
        loadStages,
        loadSessions,
        checkpoint: new ProjectModelCheckpoint(state, () => {
          persisted = JSON.stringify({ snapshot, state })
        }),
        progress: createProjectRunReporter((event) => events.push(event)),
        createModel: () => ({
          name: "default",
          budget: projectContextBudget({ maxTokens: 32768, maxOutputTokens: 4096 }),
          agent,
          final: agent,
          reviewer
        })
      })
    const restart = () => {
      const saved = JSON.parse(persisted)
      snapshot = saved.snapshot
      state = saved.state
      phase++
    }
    await expect(generate()).rejects.toThrow()
    expect(Object.keys(state.completed)).toHaveLength(1)
    expect(state.pendingStep).toContain("全量数据审阅 2/")
    expect(agentCall).not.toHaveBeenCalled()
    const firstBatch = reviewed[0]

    restart()
    await expect(generate()).rejects.toThrow()
    expect(reviewed.filter((text) => text === firstBatch)).toHaveLength(1)
    expect(reviewed.length).toBeGreaterThan(1)
    expect(reviewed.join("\n")).toContain(snapshot.periodData.projects.at(-1)!.projectId)
    expect(loadStages).toHaveBeenCalledTimes(1)
    expect(loadSessions).toHaveBeenCalledTimes(1)
    expect(agentCall).toHaveBeenCalledTimes(3)
    const completedReviews = reviewed.length
    const callsBeforeResume = agentCall.mock.calls.length

    restart()
    const result = await generate()
    expect(result.html).toContain("续跑后的报告")
    expect(reviewed).toHaveLength(completedReviews)
    expect(agentCall).toHaveBeenCalledTimes(callsBeforeResume + 1)
    expect(loadStages).toHaveBeenCalledTimes(1)
    expect(loadSessions).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(events)).toContain("恢复已完成步骤")
    expect(
      events.some(
        (event) => event.type === "text" && event.answer === false && event.text.length > 0
      )
    ).toBe(true)
    expect(state.pendingStep).toBeUndefined()
  })

  it("resumes after saved validation observations and continues from the latest draft", async () => {
    const scope = {
      upperOrgLv1: "开发一室",
      period: { kind: "week" as const, anchorDate: "2026-10-27" }
    }
    const snapshot = buildReportSnapshot({
      scope,
      data: makeReportPeriodExample(scope),
      accumulation: null,
      active: null,
      knowledgeAsOf: "2026-11-12T00:00:00Z",
      exampleData: true
    })
    let state: ProjectModelCheckpointState = { completed: {} }
    const agentCall = vi
      .fn(async (messages: BaseMessage[]) => {
        const history = messages.map((message) => String(message.content)).join("\n")
        expect(history).toContain("第三稿仍需修正")
        expect(history).toContain("HTML 校验未通过")
        return new AIMessage(
          '<html><body><h1>修正后的报告</h1><p data-report-value="summary.projectCount"></p></body></html>'
        )
      })
      .mockResolvedValueOnce(new AIMessage("初稿不是HTML"))
      .mockResolvedValueOnce(new AIMessage("第二稿仍需修正"))
      .mockResolvedValueOnce(new AIMessage("第三稿仍需修正"))
    const onReview = vi.fn()
    const reviewer = testReviewer(onReview)
    const agent = mockStreamingModel({ invoke: agentCall })
    const final = mockStreamingModel({
      invoke: vi.fn(async () => {
        throw new Error("Unexpected separate repair request")
      })
    })
    const generate = () =>
      generateProjectReport({
        snapshot,
        instruction: "简洁",
        checkpoint: new ProjectModelCheckpoint(state, () => undefined),
        createModel: () => ({
          name: "default",
          budget: projectContextBudget({ maxTokens: 32768, maxOutputTokens: 4096 }),
          agent,
          final,
          reviewer
        })
      })
    await expect(generate()).rejects.toThrow("报告生成未完成")
    expect(agentCall).toHaveBeenCalledTimes(3)
    expect(state.pendingStep).toContain("校验反馈")
    const reviews = onReview.mock.calls.length
    state = JSON.parse(JSON.stringify(state))
    expect((await generate()).html).toContain("修正后的报告")
    expect(agentCall).toHaveBeenCalledTimes(4)
    expect(final.invoke).not.toHaveBeenCalled()
    expect(onReview).toHaveBeenCalledTimes(reviews)
  })

  it.each([false, true])(
    "recovers legacy saved HTML without replaying model requests unless the model changed: %s",
    async (changeModel) => {
      const scope = {
        upperOrgLv1: "开发一室",
        period: { kind: "week" as const, anchorDate: "2026-10-27" }
      }
      const snapshot = buildReportSnapshot({
        scope,
        data: makeReportPeriodExample(scope),
        accumulation: null,
        active: null,
        knowledgeAsOf: "2026-11-12T00:00:00Z",
        exampleData: true
      })
      const state: ProjectModelCheckpointState = { completed: {} }
      const old = new ProjectModelCheckpoint(state, () => undefined)
      await old.run(
        "previous-release-prompt",
        [new HumanMessage("旧版生成上下文")],
        "报告生成 · original-model · 第 4 轮",
        new AbortController().signal,
        createProjectRunReporter(),
        async () =>
          new AIMessage(
            '<html><body><h1>旧任务报告</h1><p data-report-value="overview.meta.period"></p><b data-report-value="overview.summary.projectCount"></b></body></html>'
          )
      )
      old.markPending("报告生成 · original-model · 第 5 轮")
      const invoke = vi.fn(
        async () =>
          new AIMessage(
            '<html><body><h1>新模型报告</h1><p data-report-value="meta.period"></p></body></html>'
          )
      )
      const model = mockStreamingModel({ invoke })
      const onReview = vi.fn()
      const events: ProjectAgentRunEvent[] = []
      const result = await generateProjectReport({
        snapshot,
        instruction: "原报告要求",
        checkpoint: new ProjectModelCheckpoint(JSON.parse(JSON.stringify(state)), () => undefined),
        progress: createProjectRunReporter((event) => events.push(event)),
        createModel: () => ({
          name: changeModel ? "new-model" : "original-model",
          budget: projectContextBudget({ maxTokens: 32768, maxOutputTokens: 4096 }),
          agent: model,
          final: model,
          reviewer: testReviewer(onReview)
        })
      })
      expect(result.html).toContain(String(snapshot.facts.meta.period))
      expect(result.source).not.toContain("overview.meta")
      if (changeModel) {
        expect(result.html).toContain("新模型报告")
        expect(invoke).toHaveBeenCalledTimes(1)
        expect(onReview).toHaveBeenCalled()
      } else {
        expect(result.html).toContain("旧任务报告")
        expect(invoke).not.toHaveBeenCalled()
        expect(onReview).not.toHaveBeenCalled()
        expect(JSON.stringify(events)).toContain("恢复已保存的报告 HTML")
        expect(
          events.some(
            (event) =>
              event.type === "text" && event.answer === false && event.text.includes("旧任务报告")
          )
        ).toBe(true)
      }
    }
  )

  it("does not reuse responses for different data or model/context configuration", async () => {
    const state: ProjectModelCheckpointState = { completed: {} }
    const checkpoint = new ProjectModelCheckpoint(state, () => undefined)
    const request = vi.fn(async () => new AIMessage("完成"))
    const signal = new AbortController().signal
    const progress = createProjectRunReporter()
    const run = (identity: string, text: string) =>
      checkpoint.run(identity, [new HumanMessage(text)], "步骤", signal, progress, request)
    await run("default:32k", "原数据")
    await run("default:32k", "原数据")
    expect(request).toHaveBeenCalledTimes(1)
    await run("default:64k", "原数据")
    await run("default:64k", "新数据")
    expect(request).toHaveBeenCalledTimes(3)
    await expect(
      checkpoint.run(
        "default:32k",
        [new HumanMessage("失败")],
        "失败步骤",
        signal,
        progress,
        async () => {
          throw new Error("中断")
        }
      )
    ).rejects.toThrow("中断")
    expect(Object.keys(state.completed)).toHaveLength(3)
    expect(state.pendingStep).toBe("失败步骤")
    await checkpoint.run(
      "default:32k",
      [new HumanMessage("空结果")],
      "空步骤",
      signal,
      progress,
      async () => new AIMessage("  \n")
    )
    expect(Object.keys(state.completed)).toHaveLength(3)
    expect(state.pendingStep).toBe("空步骤")
  })
})
