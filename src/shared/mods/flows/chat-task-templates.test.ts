import { expect, it } from "vitest"
import { createAutobizPreset } from "./autobiz-presets"
import {
  CHAT_TASK_TEMPLATES,
  chatTaskTemplateIssue,
  createChatTaskTemplate,
  findSavedChatTaskTemplate
} from "./chat-task-templates"
import { parseFlowDefinition } from "./schema"
import type { FlowCatalog, FlowDefinition, SavedFlow } from "./types"

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

const savedTemplate = (definition: FlowDefinition): SavedFlow => ({
  definition,
  revision: 3,
  digest: "a".repeat(64),
  updatedAt: 1
})

it.each(CHAT_TASK_TEMPLATES)(
  "reuses the exact persisted $id definition without changing its id or revision",
  ({ id }) => {
    const saved = savedTemplate(createChatTaskTemplate(id, "user-stored-id"))
    const original = structuredClone(saved)
    expect(findSavedChatTaskTemplate(id, [saved])).toBe(saved)
    expect(saved).toEqual(original)
    expect(findSavedChatTaskTemplate(id, [])).toBeUndefined()
  }
)

it.each([
  [
    "model",
    (flow: FlowDefinition) => {
      Object.assign(flow.steps[0], { modelId: "different" })
    }
  ],
  [
    "model role",
    (flow: FlowDefinition) => {
      Object.assign(flow.steps[0], { modelRole: "reviewer" })
    }
  ],
  [
    "check",
    (flow: FlowDefinition) => {
      Object.assign(flow.steps[1], { check: "e2e" })
    }
  ],
  [
    "step",
    (flow: FlowDefinition) => {
      flow.steps[0].enabled = false
    }
  ],
  [
    "prompt",
    (flow: FlowDefinition) => {
      Object.assign(flow.steps[0], { prompt: "User-edited review" })
    }
  ],
  [
    "goal",
    (flow: FlowDefinition) => {
      flow.goal = "User-edited goal"
    }
  ],
  [
    "timeout",
    (flow: FlowDefinition) => {
      flow.timeoutMs = 60000
    }
  ],
  [
    "execution budget",
    (flow: FlowDefinition) => {
      flow.maxExecutions++
    }
  ],
  [
    "name",
    (flow: FlowDefinition) => {
      flow.name = "My template"
    }
  ]
] as const)("does not mistake an edited %s for the built-in template", (_label, edit) => {
  const saved = savedTemplate(createChatTaskTemplate("review-test", "user-stored-id"))
  edit(saved.definition)
  const original = structuredClone(saved)
  expect(findSavedChatTaskTemplate("review-test", [saved])).toBeUndefined()
  expect(saved).toEqual(original)
})

it("ignores malformed identities and other presets, without falling back to a same-name match", () => {
  const saved = savedTemplate(createChatTaskTemplate("review", "bad id"))
  expect(findSavedChatTaskTemplate("review", [saved])).toBeUndefined()
  saved.definition.id = "valid-id"
  saved.revision = 0
  expect(findSavedChatTaskTemplate("review", [saved])).toBeUndefined()
  saved.revision = 1
  saved.definition = { ...createChatTaskTemplate("repair-retest", "valid-id"), name: "只读检视" }
  expect(findSavedChatTaskTemplate("review", [saved])).toBeUndefined()
})
