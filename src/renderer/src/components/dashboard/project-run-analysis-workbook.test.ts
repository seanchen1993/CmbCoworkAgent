import { expect, it, vi } from "vitest"
import * as XLSX from "xlsx"
import { makeMockRunAnalysis } from "../../../../main/ipc/project-run-analysis-mock"
import {
  emptyStageTurnCounts,
  type RunAnalysisPluginStages
} from "../../../../shared/project-run-analysis"
import { DEFAULT_RUN_ANALYSIS_FILTERS } from "./project-run-analysis-view"
import { downloadRunAnalysisWorkbook } from "./project-run-analysis-workbook"

vi.mock("xlsx", async (original) => ({
  ...(await original<typeof XLSX>()),
  writeFile: vi.fn()
}))

it("每个插件以特性为行，以配置阶段和历史阶段为列，分开未知值和已知零", () => {
  const data = makeMockRunAnalysis({ from: "2020-01-01", to: "2030-01-01" })
  const names = ["A/B", "A/B", "a:b", "研".repeat(28) + "🧑‍💻", "研".repeat(28) + "2", null]
  const matches = names.map((adapterName, i) => ({
    reasons: [],
    row: {
      ...data.rows[i],
      projectId: String(i),
      featureSlug: "same",
      featureTitle: `特性${i}`,
      adapterName,
      conversationCount: i < 2 ? 3 : 0,
      completedNodeConversationCount: i < 2 ? 1 : 0,
      unattributedSkillConversationCount: i === 0 ? null : 0
    }
  }))
  data.workflowStageNamesByProject = { "0": ["设计", "未执行"], "2": ["取数"] }
  const zero = emptyStageTurnCounts()
  const stages = [
    { ...zero, projectId: "0", featureSlug: "same", nodeName: null, conversationCount: 1 },
    {
      ...zero,
      projectId: "0",
      featureSlug: "same",
      nodeName: "设计",
      conversationCount: 2,
      nodeStatusReported: 2,
      completedNode: 1
    },
    {
      ...zero,
      projectId: "1",
      featureSlug: "same",
      nodeName: "历史阶段",
      conversationCount: 3,
      nodeStatusReported: 3,
      skillAttributionReported: 3,
      completedNode: 1
    }
  ]
  const plugins: RunAnalysisPluginStages[] = [...new Set(names)].map((adapterName) => ({
    adapterName,
    stages: adapterName === "A/B" ? stages : []
  }))
  const input = {
    data,
    matches,
    plugins,
    filters: DEFAULT_RUN_ANALYSIS_FILTERS,
    sort: "idle" as const,
    desc: true
  }
  downloadRunAnalysisWorkbook(input)
  const book = vi.mocked(XLSX.writeFile).mock.calls[0][0]
  const sheets = book.SheetNames.filter((name) => name.startsWith("插件-"))
  expect(new Set(sheets.map((name) => name.toLowerCase())).size).toBe(5)
  expect(
    sheets.every(
      (name) => name.length <= 31 && !Array.from(name).some((ch) => "\\/:?*[]".includes(ch))
    )
  ).toBe(true)
  const all = sheets.map((name) =>
    XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[name], { defval: null })
  )
  const rows = all.find((rows) => rows[0].插件名称 === "A/B")!
  expect(rows.map((r) => r.特性名称)).toEqual(["特性0", "特性1"])
  expect(Object.keys(rows[0]).filter((k) => k.endsWith(" · 主对话（轮）"))).toEqual(
    ["设计", "未执行", "历史阶段", "未记录阶段"].map((name) => name + " · 主对话（轮）")
  )
  expect(rows[0]).toMatchObject({
    "设计 · 主对话（轮）": 2,
    "设计 · 节点完成后（次）": 1,
    "设计 · 无 Skill 归因（次）": null,
    "未记录阶段 · 主对话（轮）": 1,
    "未记录阶段 · 节点完成后（次）": null,
    "未执行 · 无 Skill 归因（次）": 0,
    "历史阶段 · 主对话（轮）": 0
  })
  expect(rows[1]).toMatchObject({
    "历史阶段 · 主对话（轮）": 3,
    "历史阶段 · 节点完成后（次）": 1,
    "历史阶段 · 无 Skill 归因（次）": 0,
    "设计 · 主对话（轮）": 0
  })
  const dataRow = all.find((rows) => rows[0].插件名称 === "a:b")![0]
  expect(dataRow["取数 · 主对话（轮）"]).toBe(0)
  expect(dataRow).not.toHaveProperty("设计 · 主对话（轮）")
  const full = XLSX.utils.sheet_to_json(book.Sheets["匹配特性"])
  expect(full).toHaveLength(matches.length)
  expect(full[0]).not.toHaveProperty("设计 · 主对话（轮）")

  matches[0].row.conversationCount++
  matches[1].row.conversationCount--
  expect(() => downloadRunAnalysisWorkbook(input)).toThrow("对话数据已更新")
  expect(XLSX.writeFile).toHaveBeenCalledTimes(1)
})
