import { expect, it } from "vitest"
import { createAutobizPreset } from "./autobiz-presets"
import {
  CHAT_TASK_TEMPLATES,
  chatTaskTemplateIssue,
  createChatTaskTemplate
} from "./chat-task-templates"
import { parseFlowDefinition } from "./schema"
import type { FlowCatalog } from "./types"

const catalog: FlowCatalog = {
  available: true,
  hostAvailable: true,
  workspace: "/project",
  plugins: [],
  agents: [],
  models: [{ id: "model", name: "Model" }],
  features: [],
  unitTest: { ready: true, command: "npm run test" }
}
it.each(CHAT_TASK_TEMPLATES)(
  "reuses existing valid native steps for $id without plugin ownership",
  (template) => {
    const actual = createChatTaskTemplate(template.id, "test")
    expect(actual.steps).toEqual(createAutobizPreset(template.id, "test").steps)
    expect(parseFlowDefinition(actual)).toEqual(actual)
    expect(actual.schemaVersion).toBe(2)
    expect(actual).not.toHaveProperty("plugin")
    expect(chatTaskTemplateIssue(template.id, catalog)).toBeNull()
  }
)
it("blocks missing model, authority and actual tests without hiding the read-only alternative", () => {
  expect(chatTaskTemplateIssue("review", { ...catalog, hostAvailable: false })).toContain("开启")
  expect(chatTaskTemplateIssue("review", { ...catalog, models: [] })).toContain("模型")
  expect(
    chatTaskTemplateIssue("review-test", {
      ...catalog,
      unitTest: { ready: false, reason: "缺少 test" }
    })
  ).toBe("缺少 test")
  expect(chatTaskTemplateIssue("review", { ...catalog, unitTest: { ready: false } })).toBeNull()
  expect(chatTaskTemplateIssue("repair-retest", { ...catalog, unitTest: undefined })).toContain(
    "未核对"
  )
})
