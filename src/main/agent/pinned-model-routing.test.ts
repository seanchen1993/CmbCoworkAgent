import { beforeEach, describe, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({
  key: "",
  exists: true,
  defaultLookup: vi.fn(),
  createRuntime: vi.fn(),
  createProvider: vi.fn()
}))
vi.mock("../storage", () => ({
  getGlobalRoutingMode: () => "pinned",
  DEFAULT_MAX_TOKENS: 128000,
  DEFAULT_TOP_P: 0.95,
  DEFAULT_TOP_K: 40
}))
vi.mock("../models/registry", () => ({
  getModelConfigByRef: (ref: string) =>
    state.exists && ref === "custom:cheap"
      ? { id: "cheap", source: "custom", apiKey: state.key, tier: "economy" }
      : null,
  getAvailableModelConfigOrDefault: state.defaultLookup,
  getModelConfigs: () => [],
  getModelByTier: () => null,
  toModelRef: (c: { source: string; id: string }) => `${c.source}:${c.id}`
}))
vi.mock("./runtime", () => ({ createAgentRuntime: state.createRuntime }))
vi.mock("../harness-board/service", () => ({
  buildHarnessFeatureAgentContext: vi.fn(),
  getHarnessProjectAdapterSnapshot: vi.fn(),
  readHarnessFeatureMetadata: vi.fn(),
  resolveHarnessFeaturePluginIdentity: vi.fn(),
  resolveHarnessFeatureCurrentStage: vi.fn()
}))
vi.mock("@langchain/openai", () => ({ ChatOpenAI: state.createProvider }))
vi.mock("../db", () => ({ getThreadCore: () => null, updateThread: vi.fn() }))
import {
  resolveStandardTurnRouting,
  prepareStandardThreadRuntimeFactory
} from "./standard-thread-turn"
import { SelectedModelUnavailableError } from "../models/selection-error"

beforeEach(() => {
  vi.clearAllMocks()
  state.key = ""
  state.exists = true
})
describe("pinned model runtime admission", () => {
  it.each([true, false])(
    "propagates unavailable selection before runtime/provider construction (exists=%s)",
    async (exists) => {
      state.exists = exists
      const run = async () => {
        const routing = await resolveStandardTurnRouting({
          taskSource: "chat",
          threadId: "thread",
          requestedModelId: "custom:cheap",
          routingMode: "pinned"
        })
        const factory = prepareStandardThreadRuntimeFactory({
          source: "bot",
          runLease: { owner: "bot", runId: "task" },
          baseOptions: { threadId: "thread", workspacePath: "/fixture" }
        })
        for (const modelId of routing.orderedModelIds) await factory.create(modelId)
      }
      await expect(run()).rejects.toMatchObject({
        name: "SelectedModelUnavailableError",
        code: "PINNED_MODEL_UNAVAILABLE",
        message: expect.stringContaining("custom:cheap")
      })
      expect(state.defaultLookup).not.toHaveBeenCalled()
      expect(state.createRuntime).not.toHaveBeenCalled()
      expect(state.createProvider).not.toHaveBeenCalled()
    }
  )
  it.each([
    ["thread", "pinned"],
    ["btw-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002", "auto"]
  ] as const)(
    "keeps the usable pin as the only runtime candidate for %s in global mode %s",
    async (threadId, routingMode) => {
      state.key = "synthetic-only"
      const routing = await resolveStandardTurnRouting({
        taskSource: "chat",
        message: "检查当前项目",
        threadId,
        requestedModelId: "custom:cheap",
        routingMode
      })
      expect(routing.orderedModelIds).toEqual(["custom:cheap"])
      expect(state.defaultLookup).not.toHaveBeenCalled()
    }
  )
  it("never echoes credentials or credential-bearing URLs in the actionable error", () => {
    const raw = "https://secret-user:synthetic-key@example.invalid/v1"
    const error = new SelectedModelUnavailableError(raw, "missing_credentials")
    expect(error.message).toContain("管理模型与 API 配置")
    expect(error.message).not.toMatch(/secret-user|synthetic-key|example\.invalid|https:/)
  })
})
