import { readFileSync } from "node:fs"
import ts from "typescript"
import { beforeEach, expect, it, vi } from "vitest"
import type { AgentRunExecutionContext } from "./agent-run-service"

const state = vi.hoisted(() => ({
  models: [
    { id: "bot-choice", source: "custom", model: "bot-choice", tier: "premium", apiKey: "fixture" },
    { id: "auto-choice", source: "custom", model: "auto-choice", tier: "economy", apiKey: "fixture" }
  ]
}))
vi.mock("../storage", () => ({ getGlobalRoutingMode: () => "auto",
  DEFAULT_MAX_TOKENS: 128000, DEFAULT_TOP_P: 0.95, DEFAULT_TOP_K: 40 }))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => state.models[0],
  getModelByTier: (tier: string) => state.models.find((model) => model.tier === tier),
  getModelConfigByRef: (ref: string) => state.models.find((model) => `custom:${model.id}` === ref),
  getModelConfigs: () => state.models,
  toModelRef: (model: { id: string }) => `custom:${model.id}`
}))
vi.mock("../db", () => ({ getThreadCore: () => null, updateThread: vi.fn() }))
vi.mock("./runtime", () => ({ createAgentRuntime: vi.fn() }))
vi.mock("../harness-board/service", () => ({}))
vi.mock("../harness-board/managed-run-model", () => ({ getManagedRunModelOverride: () => undefined }))
import { resolveStandardTurnRouting, type StandardTurnRoutingInput } from "./standard-thread-turn"

// Exercise the routing input actually wired in Agent IPC, then the real routing/failover
// implementation. Loading the whole Electron service would require unrelated app services.
const source = ts.createSourceFile("agent.ts",
  readFileSync(new URL("../ipc/agent.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true)
let routingInput: string | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "preparedRouting" &&
      node.initializer && ts.isAwaitExpression(node.initializer) &&
      ts.isCallExpression(node.initializer.expression)) {
    routingInput = node.initializer.expression.arguments[0].getText(source)
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (!routingInput) throw new Error("Agent invocation routing entry not found")
const inputFor = new Function("runExecutionContext", "getGlobalRoutingMode", "requestedModelId",
  "routingDecisionMessage", "effectiveMessage", "threadId", `const managedExecution = false; return (${routingInput})`) as
  (context: Partial<AgentRunExecutionContext>, globalMode: () => string, model: string,
    routingMessage: string, message: string, thread: string) => StandardTurnRoutingInput

beforeEach(() => { state.models[0].apiKey = "fixture" })
it.each(["bot", "desktop", "im"] as const)("retains global auto routing without an opt-in (%s)", async (source) => {
  const result = await resolveStandardTurnRouting(inputFor({ source }, () => "auto",
    "custom:bot-choice", "你好", "你好", "thread"))
  expect(result.effectiveModelId).toBe("custom:auto-choice")
})
it("keeps the explicit Bot model as the only candidate under global auto routing", async () => {
  const result = await resolveStandardTurnRouting(inputFor({ source: "bot", modelRoutingMode: "pinned" },
    () => "auto", "custom:bot-choice", "你好", "你好", "thread"))
  expect(result.effectiveModelId).toBe("custom:bot-choice")
  expect(result.orderedModelIds).toEqual(["custom:bot-choice"])
})
it("does not silently switch a pinned Bot to a different provider when credentials are missing", async () => {
  state.models[0].apiKey = ""
  await expect(resolveStandardTurnRouting(inputFor({ source: "bot", modelRoutingMode: "pinned" },
    () => "auto", "custom:bot-choice", "你好", "你好", "thread")))
    .rejects.toMatchObject({ code: "PINNED_MODEL_UNAVAILABLE" })
})
