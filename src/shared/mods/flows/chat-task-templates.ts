import { createAutobizPreset, type AutobizPreset } from "./autobiz-presets"
import { parseFlowDefinition } from "./schema"
import type { FlowCatalog, SavedFlow } from "./types"

/** Product-facing names over the existing, validated Host presets; no second execution engine. */
export const CHAT_TASK_TEMPLATES = [
  {
    id: "review",
    name: "只读检视",
    description: "阅读相关代码，列出问题与依据，再由你确认。不会修改文件或运行测试。",
    sequence: "检视 → 汇报 → 确认"
  },
  {
    id: "review-test",
    name: "检视并测试",
    description: "检视后运行项目已有的单元测试。测试失败即停止，保留真实输出。",
    sequence: "检视 → 真实测试 → 汇报 → 确认"
  },
  {
    id: "repair-retest",
    name: "失败修复复测",
    description: "先检视并测试，仅在测试失败时修复实现并复测，最多修复两次。",
    sequence: "检视 → 测试 → 失败修复与复测 → 汇报 → 确认"
  }
] as const satisfies readonly {
  id: AutobizPreset
  name: string
  description: string
  sequence: string
}[]

export function createChatTaskTemplate(preset: AutobizPreset, id: string) {
  const description = CHAT_TASK_TEMPLATES.find((item) => item.id === preset)
  if (!description) throw Error("CHAT_TASK_TEMPLATE_UNKNOWN")
  return {
    ...createAutobizPreset(preset, id),
    name: description.name,
    goal: description.description
  }
}

/** Reuse only a native-listed, unchanged template; names alone never identify its contents. */
export function findSavedChatTaskTemplate(preset: AutobizPreset, saved: readonly SavedFlow[]) {
  const expected = JSON.stringify(parseFlowDefinition(createChatTaskTemplate(preset, "template")))
  return saved.find((item) => {
    if (!Number.isSafeInteger(item.revision) || item.revision < 1 || !item.digest) return false
    try {
      return (
        JSON.stringify({ ...parseFlowDefinition(item.definition), id: "template" }) === expected
      )
    } catch {
      return false
    }
  })
}

/** UI preflight only. Native execution still rechecks configuration, model and approvals. */
export function chatTaskTemplateIssue(preset: AutobizPreset, catalog: FlowCatalog): string | null {
  if (!catalog.available || !catalog.workspace)
    return catalog.reason || "请先打开已选择项目目录的本地聊天。"
  if (!catalog.hostAvailable)
    return catalog.reason || "请先在灵件设置开启灵件功能，再回来刷新。无需安装其他插件。"
  if (!catalog.models.length) return "尚未配置可用模型。请打开应用设置，完成模型配置后回来刷新。"
  if (preset !== "review" && !catalog.unitTest?.ready)
    return catalog.unitTest?.reason || "尚未核对项目测试入口。请更新应用，或先选用“只读检视”。"
  return null
}
