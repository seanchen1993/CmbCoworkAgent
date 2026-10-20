import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  metadata: null as string | null,
  defaultLookup: vi.fn()
}))

const configs = vi.hoisted(() => [
  {
    id: "premium",
    ref: "builtin:premium",
    source: "builtin",
    origin: "remote",
    name: "Premium",
    baseUrl: "https://builtin.example.com/v1",
    model: "premium",
    apiKey: "builtin-key",
    maxTokens: 128_000,
    tier: "premium"
  },
  {
    id: "shared",
    ref: "builtin:shared",
    source: "builtin",
    origin: "remote",
    name: "Builtin Economy",
    baseUrl: "https://builtin.example.com/v1",
    model: "builtin-economy",
    apiKey: "builtin-key",
    maxTokens: 32_000,
    tier: "economy"
  },
  {
    id: "shared",
    ref: "custom:shared",
    source: "custom",
    name: "Custom Economy",
    baseUrl: "https://custom.example.com/v1",
    model: "custom-economy",
    apiKey: "custom-key",
    maxTokens: 200_000,
    tier: "economy"
  }
])

vi.mock("../storage", () => ({
  DEFAULT_MAX_TOKENS: 128_000,
  DEFAULT_TOP_P: 0.95,
  DEFAULT_TOP_K: 40,
  getGlobalRoutingMode: () => "pinned"
}))

vi.mock("../models/registry", () => ({
  getModelConfigs: () => configs,
  getAvailableModelConfigOrDefault: () => {
    state.defaultLookup()
    return configs.find((config) => Boolean(config.apiKey)) ?? null
  },
  getModelByTier: (tier: "premium" | "economy") =>
    configs.find((config) => config.tier === tier) ?? configs[0] ?? null,
  getModelConfigByRef: (value: string) =>
    configs.find((config) => config.ref === value) ??
    configs.find((config) => config.source === "custom" && config.id === value) ??
    null,
  toModelRef: (config: { source: string; id: string }) => `${config.source}:${config.id}`
}))

vi.mock("../db", () => ({
  getThreadCore: () => (state.metadata === null ? null : { metadata: state.metadata }),
  updateThread: vi.fn()
}))

import { resolveModel } from "./index"

beforeEach(() => {
  state.metadata = null
  state.defaultLookup.mockClear()
})

describe("routing with managed model refs", () => {
  it("refuses a removed explicit pinned model instead of changing provider", async () => {
    await expect(
      resolveModel({
        taskSource: "chat",
        routingMode: "pinned",
        requestedModelId: "builtin:removed"
      })
    ).rejects.toMatchObject({ code: "PINNED_MODEL_UNAVAILABLE", reason: "missing_config" })
    expect(state.defaultLookup).not.toHaveBeenCalled()
  })
  it("refuses missing credentials, then uses the same saved ref once credentials are restored", async () => {
    const config = configs[2],
      key = config.apiKey
    try {
      config.apiKey = ""
      await expect(
        resolveModel({ taskSource: "chat", routingMode: "pinned", requestedModelId: config.ref })
      ).rejects.toMatchObject({ code: "PINNED_MODEL_UNAVAILABLE", reason: "missing_credentials" })
      expect(state.defaultLookup).not.toHaveBeenCalled()
      config.apiKey = key
      expect(
        (
          await resolveModel({
            taskSource: "chat",
            routingMode: "pinned",
            requestedModelId: config.ref
          })
        ).resolvedModelId
      ).toBe("custom:shared")
    } finally {
      config.apiKey = key
    }
  })
  it("keeps default selection for an unspecified or blank pinned request", async () => {
    for (const requestedModelId of [undefined, "", "  "])
      expect(
        (await resolveModel({ taskSource: "chat", routingMode: "pinned", requestedModelId }))
          .resolvedModelId
      ).toBe("builtin:premium")
    expect(state.defaultLookup).toHaveBeenCalledTimes(3)
  })

  it("reroutes a continuation when its previous managed model no longer exists", async () => {
    state.metadata = JSON.stringify({
      routingState: {
        lastResolvedModelId: "builtin:removed",
        lastResolvedTier: "economy"
      }
    })

    const result = await resolveModel({
      taskSource: "chat",
      threadId: "thread-1",
      message: "检查 src/app.ts",
      routingMode: "auto",
      continuation: "resume"
    })

    expect(result.resolvedModelId).toBe("builtin:premium")
    expect(result.layer).toBe("layer2")
  })

  it("treats same-ID builtin and custom models as separate capacity candidates", async () => {
    state.metadata = JSON.stringify({ routingState: { lastInputTokens: 30_000 } })

    const result = await resolveModel({
      taskSource: "chat",
      threadId: "thread-1",
      message: "你好",
      routingMode: "auto"
    })

    expect(result.resolvedModelId).toBe("custom:shared")
    expect(result.routeReason).toContain("context-guard:switch-economy")
  })
})
