import { beforeEach, expect, it, vi } from "vitest"
import { resolveStandardTurnRouting } from "./standard-thread-turn"

const state = vi.hoisted(() => ({
  models: [
    { id: "text", apiKey: "fixture", source: "custom", tier: "premium", inputModalities: ["text"] },
    { id: "a", apiKey: "fixture", source: "custom", tier: "premium", inputModalities: ["text", "image"] },
    { id: "b", apiKey: "fixture", source: "custom", tier: "premium", inputModalities: ["text", "image"] }
  ],
  routing: { lastResolvedModelId: "", failoverStickyModelId: "", failoverStickyUntil: 0 },
  managed: ""
}))
vi.mock("../db", () => ({ getThreadCore: () => ({ metadata: JSON.stringify({ routingState: state.routing }) }) }))
vi.mock("../models/registry", () => ({
  getModelConfigs: () => state.models,
  getModelConfigByRef: (ref: string) => state.models.find(model => "custom:" + model.id === ref),
  toModelRef: (model: { id: string }) => "custom:" + model.id
}))
vi.mock("../harness-board/managed-run-model", () => ({ getManagedRunModelOverride: () => state.managed }))
vi.mock("./runtime", () => ({ createAgentRuntime: vi.fn() }))

const input = { taskSource: "chat", threadId: "thread", requiresImages: true,
  requestedModelId: "custom:a", routingMode: "auto" } as const

beforeEach(() => {
  state.routing.lastResolvedModelId = "custom:b"
  state.routing.failoverStickyModelId = "custom:b"
  state.routing.failoverStickyUntil = Date.now() + 60000
  state.models[2].apiKey = "fixture"
  state.managed = ""
})

it.each(["resume", "interrupt"] as const)("continues on the last eligible visual model for %s", async continuation => {
  state.routing.failoverStickyModelId = "custom:a"
  const result = await resolveStandardTurnRouting({ ...input, continuation })
  expect(result.orderedModelIds).toEqual(["custom:b", "custom:a"])
  expect(result.result?.layer).toBe("thread")
})

it("honors an unexpired failover preference, checking credentials and image capability again", async () => {
  expect((await resolveStandardTurnRouting(input)).effectiveModelId).toBe("custom:b")
  state.routing.failoverStickyUntil = Date.now() - 1000
  expect((await resolveStandardTurnRouting(input)).effectiveModelId).toBe("custom:a")
  state.models[2].apiKey = ""
  state.routing.failoverStickyModelId = "custom:text"
  state.routing.failoverStickyUntil = Date.now() + 60000
  expect((await resolveStandardTurnRouting({ ...input, continuation: "resume" })).orderedModelIds).toEqual(["custom:a"])
})

it("keeps an explicit or managed pin regardless of continuity", async () => {
  expect((await resolveStandardTurnRouting({ ...input, routingMode: "pinned" })).orderedModelIds).toEqual(["custom:a"])
  state.managed = "custom:text"
  await expect(resolveStandardTurnRouting(input)).rejects.toThrow("视觉模型")
})
