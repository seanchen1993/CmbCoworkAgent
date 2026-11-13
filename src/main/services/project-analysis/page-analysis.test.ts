import { mockStreamingModel, reviewTestContext } from "./streaming-model-test-fixture"
import { describe, expect, it, vi } from "vitest"
import { AIMessage, type BaseMessage } from "@langchain/core/messages"
import { makeMockRunAnalysis } from "../../ipc/project-run-analysis-mock"
import {
  attentionReasons,
  runAnalysisPreset,
  RUN_ANALYSIS_PRESETS
} from "../../../shared/project-run-analysis-metrics"
import { diagnoseProjects } from "./project-diagnostics"
import { reviewAllData } from "./full-data-review"
import { loadCompleteProjectList, pageDatasets, projectListPageData } from "./page-data"

const range = { from: "2026-10-01T00:00:00Z", to: "2026-10-31T23:59:59Z" }
const signal = () => new AbortController().signal
describe("page-based full data and diagnosis", () => {
  it("scans every analysis row and agrees with the six UI preset filters", () => {
    const data = makeMockRunAnalysis(range)
    const result = diagnoseProjects(data.rows, data.dataAsOf)
    expect(result.examinedFeatures).toBe(36)
    expect(result.examinedProjects).toBe(12)
    for (const rule of RUN_ANALYSIS_PRESETS) {
      const expected = data.rows
        .filter((row) => attentionReasons(row, runAnalysisPreset(rule.key), data.dataAsOf) !== null)
        .map((row) => `${row.projectId}/${row.featureSlug}`)
        .sort()
      const actual = result.projects
        .flatMap((project) =>
          project.features
            .filter((feature) => feature.signals.some((s) => s.rule === rule.key))
            .map((feature) => `${project.projectId}/${feature.featureSlug}`)
        )
        .sort()
      expect(actual).toEqual(expected)
    }
    expect(
      result.projects.some((project) => project.projectId === data.rows.at(-1)!.projectId)
    ).toBe(true)
  })
  it("does not classify missing fields as zero, skips archived idleness and accepts explicit thresholds", () => {
    const data = makeMockRunAnalysis(range),
      row = { ...data.rows[1] }
    row.toolCalls = null
    row.codeStats = null
    row.lastExecutedAt = null
    row.executionSpanMs = null
    row.noSkillConversationCount = 0
    row.vibeAdoptedShare = null
    expect(diagnoseProjects([row], data.dataAsOf)).toMatchObject({
      candidateProjects: 0,
      unknown: { codeAdoption: 1, lastExecution: 1, toolCalls: 1 }
    })
    row.lastExecutedAt = new Date(Date.parse(data.dataAsOf) - 10 * 86400000).toISOString()
    expect(diagnoseProjects([row], data.dataAsOf).candidateProjects).toBe(0)
    expect(
      diagnoseProjects([row], data.dataAsOf, { idleDays: 7 }).projects[0].features[0].signals[0]
    ).toMatchObject({ rule: "idle", observed: { idleDays: 10 } })
    row.lifecycleStatus = "archived"
    expect(diagnoseProjects([row], data.dataAsOf, { idleDays: 7 }).candidateProjects).toBe(0)
  })
  it("exposes visible project fields and all analysis columns without exposing workspace paths", () => {
    const data = makeMockRunAnalysis(range)
    const pages = projectListPageData(
      [
        {
          projectId: "p1",
          name: "项目",
          workspacePath: "/secret/local/path",
          elapsedMs: 86400000,
          runCost: { modelCalls: 9 },
          hookExecutions: { success: 3 },
          features: [{ slug: "f1", title: "特性", codeStats: { generatedLines: 10 } }]
        }
      ],
      data
    )
    expect(pages.projectList[0]).toMatchObject({
      elapsedMs: 86400000,
      runCost: { modelCalls: 9 },
      hookExecutions: { success: 3 }
    })
    expect(pages.projectList[0]).not.toHaveProperty("workspacePath")
    expect(pages.projectFeatures[0]).toMatchObject({ projectId: "p1", slug: "f1" })
    expect(pageDatasets(pages)[2].rows.at(-1)).toMatchObject({
      projectId: data.rows.at(-1)!.projectId,
      creator: data.rows.at(-1)!.creator
    })
  })
  it("loads all active and archived pages beyond the first 100 records", async () => {
    const query = vi.fn(
      async ({
        status,
        page,
        pageSize
      }: {
        status: "active" | "archived"
        page: number
        pageSize: number
      }) => {
        const total = status === "active" ? 150 : 80
        return {
          projects: Array.from({ length: total }, (_, i) => ({
            projectId: `${status}-${i}`
          })).slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          truncated: false,
          total
        }
      }
    )
    const projects = await loadCompleteProjectList(query, signal())
    expect(projects).toHaveLength(230)
    expect(projects.at(-1)).toEqual({ projectId: "archived-79" })
    expect(query).toHaveBeenCalledTimes(3)
  })
  it("refuses incomplete, duplicated and silently clamped project pagination", async () => {
    await expect(
      loadCompleteProjectList(
        async () => ({ projects: [], total: 1, page: 1, pageSize: 100, truncated: false }),
        signal()
      )
    ).rejects.toThrow("缺少")
    await expect(
      loadCompleteProjectList(
        async () => ({
          projects: [{ projectId: "same" }],
          total: 1,
          page: 1,
          pageSize: 100,
          truncated: false
        }),
        signal()
      )
    ).rejects.toThrow("重复")
    await expect(
      loadCompleteProjectList(
        async () => ({ projects: [], total: 0, page: 1, pageSize: 100, truncated: true }),
        signal()
      )
    ).rejects.toThrow("未完整")
  })
  it("passes the last row as well as the first row in small complete datasets", async () => {
    const model = {
      invoke: vi.fn(async (_messages: BaseMessage[]) => new AIMessage("已完整审阅全部人员"))
    }
    const result = await reviewAllData(
      [
        {
          name: "全部人员",
          basis: "本期",
          rows: Array.from({ length: 40 }, (_, i) => ({ name: `member-${i}`, count: i }))
        }
      ],
      "综合报告",
      mockStreamingModel(model),
      signal(),
      ...reviewTestContext(mockStreamingModel(model), signal())
    )
    expect(String(model.invoke.mock.calls[0][0][1].content)).toContain("member-39")
    expect(result.note).toContain("40条")
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })
  it("sends every row of large datasets in complete batches before final synthesis", async () => {
    const seen: number[] = []
    const model = {
      invoke: vi.fn(async (messages: BaseMessage[]) => {
        const payload = JSON.parse(String(messages[1].content).split("对应：\n")[1])
        for (const part of payload) {
          const column = part.fields.indexOf("rowId")
          seen.push(...part.values.map((row: unknown[]) => Number(row[column])))
        }
        return new AIMessage("已审阅本批，末位项目需要结合低采纳核实。")
      })
    }
    const result = await reviewAllData(
      [
        {
          name: "项目分析",
          basis: "累计",
          rows: Array.from({ length: 600 }, (_, i) => ({
            rowId: i,
            description: "数据".repeat(300)
          }))
        }
      ],
      "诊断异常项目",
      mockStreamingModel(model),
      signal(),
      ...reviewTestContext(mockStreamingModel(model), signal())
    )
    expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => i))
    expect(model.invoke.mock.calls.length).toBeGreaterThan(2)
    expect(result.context).toContain("全部数据")
    expect(result.note).toContain("600条")
  })
  it("does not produce partial review notes after failure or cancellation", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i, description: "x".repeat(600) }))
    const controller = new AbortController()
    const model = {
      invoke: vi.fn(async () => {
        controller.abort()
        return new AIMessage("一批完成")
      })
    }
    await expect(
      reviewAllData(
        [{ name: "项目分析", basis: "累计", rows }],
        "诊断",
        mockStreamingModel(model),
        controller.signal,
        ...reviewTestContext(mockStreamingModel(model), controller.signal)
      )
    ).rejects.toThrow()
    expect(model.invoke).toHaveBeenCalledTimes(1)
    await expect(
      reviewAllData(
        [{ name: "项目分析", basis: "累计", rows }],
        "诊断",
        mockStreamingModel({ invoke: async () => new AIMessage("") }),
        signal(),
        ...reviewTestContext(
          mockStreamingModel({ invoke: async () => new AIMessage("") }),
          signal()
        )
      )
    ).rejects.toThrow("审阅未完成")
  })
})
