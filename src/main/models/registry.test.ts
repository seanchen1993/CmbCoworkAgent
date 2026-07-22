import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  overrides: {} as Record<string, Record<string, unknown>>,
  customConfigs: [] as Array<Record<string, unknown>>,
  storedDefault: "",
  sourceBaseUrl: "https://updates.example.com",
  localApiKey: "local-test-key",
  bundledApiKey: "bundled-test-key",
  fetchGate: null as Promise<void> | null
}))

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock("../storage", () => ({
  DEFAULT_MAX_TOKENS: 128_000,
  MIN_MAX_TOKENS: 32_000,
  MAX_MAX_TOKENS: 1_000_000,
  DEFAULT_MAX_OUTPUT_TOKENS: 8_192,
  MIN_MAX_OUTPUT_TOKENS: 1,
  MAX_MAX_OUTPUT_TOKENS: 100_000,
  DEFAULT_TEMPERATURE: 0.1,
  MAX_TEMPERATURE: 2,
  DEFAULT_TOP_P: 0.95,
  MAX_TOP_P: 1,
  DEFAULT_TOP_K: 40,
  MIN_TOP_K: 0,
  MAX_TOP_K: 1_000,
  DEFAULT_THINKING_EFFORT: "high",
  getBuiltinModelOverrides: () => state.overrides,
  getBuiltinModelApiKey: (options?: { allowBundledFallback?: boolean }) =>
    state.localApiKey ||
    (options?.allowBundledFallback === false ? undefined : state.bundledApiKey || undefined),
  setBuiltinModelOverride: (id: string, value: Record<string, unknown>) => {
    state.overrides[id] = value
  },
  resetBuiltinModelOverride: (id: string) => {
    delete state.overrides[id]
  },
  getCustomModelConfigs: () => state.customConfigs,
  getStoredDefaultModelId: () => state.storedDefault
}))

vi.mock("../updater/checker", () => ({
  fetchLatestJson: vi.fn(async () => {
    if (state.fetchGate) await state.fetchGate
    return state.manifest
  })
}))

vi.mock("../updater/channel-config", () => ({
  resolveUpdateSource: () => ({
    channel: "production",
    baseUrl: state.sourceBaseUrl,
    manifestFile: "cmbdevclaw-latest.json"
  })
}))

import {
  getAvailableModelConfigOrDefault,
  getBuiltinModelConfigs,
  getBuiltinModelPublicConfigs,
  getDefaultModelConfig,
  getModelConfigByRef,
  getModelConfigs,
  refreshBuiltinModelCatalog,
  startBuiltinModelCatalogRefresh,
  stopBuiltinModelCatalogRefresh,
  updateBuiltinModelOverride
} from "./registry"

beforeEach(() => {
  stopBuiltinModelCatalogRefresh()
  state.manifest = {}
  state.overrides = {}
  state.customConfigs = []
  state.storedDefault = ""
  state.sourceBaseUrl = "https://updates.example.com"
  state.localApiKey = "local-test-key"
  state.bundledApiKey = "bundled-test-key"
  state.fetchGate = null
  vi.restoreAllMocks()
})

describe("builtin model registry", () => {
  it("returns a promise that waits for the initial catalog request", async () => {
    let releaseFetch!: () => void
    state.fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    let settled = false

    const initialLoad = startBuiltinModelCatalogRefresh().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseFetch()
    await initialLoad
    expect(settled).toBe(true)
  })

  it("uses the two local models when the manifest has no catalog", async () => {
    await refreshBuiltinModelCatalog(true)
    const configs = getBuiltinModelConfigs()

    expect(configs.map((item) => item.ref)).toEqual([
      "builtin:minimax-m2p5-229b-w8a8",
      "builtin:deepseek-v4-flash-284b-a13b-w8a8"
    ])
    expect(configs[0]).toMatchObject({
      temperature: 1,
      enableThinking: true,
      interleavedThinking: true,
      tier: "premium",
      origin: "fallback"
    })
    expect(configs[1]).toMatchObject({
      temperature: 0.1,
      enableThinking: false,
      tier: "economy",
      origin: "fallback"
    })
    expect(configs.every((item) => Boolean(item.apiKey))).toBe(true)
  })

  it("fills omitted remote fields from model defaults and the local API key", async () => {
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            baseUrl: "https://llm.example.com/v1",
            model: "deepseek-v4-flash-test"
          }
        ]
      }
    }

    await refreshBuiltinModelCatalog(true)
    const [config] = getBuiltinModelConfigs()
    expect(config).toMatchObject({
      id: "deepseek-v4-flash-test",
      name: "deepseek-v4-flash-test",
      temperature: 0.1,
      maxTokens: 128_000,
      maxOutputTokens: 8_192,
      tier: "economy",
      origin: "remote"
    })
    expect(config.apiKey).toBe("local-test-key")
  })

  it("does not invent a credential when neither local nor remote key is configured", async () => {
    state.localApiKey = ""
    state.bundledApiKey = ""
    await refreshBuiltinModelCatalog(true)

    expect(getBuiltinModelConfigs().every((config) => config.apiKey === undefined)).toBe(true)
    expect(getBuiltinModelPublicConfigs().every((config) => config.hasApiKey === false)).toBe(true)
  })

  it("injects the bundled fallback credential into MiniMax only", async () => {
    state.localApiKey = ""
    await refreshBuiltinModelCatalog(true)

    const configs = getBuiltinModelConfigs()
    expect(configs.find((config) => config.model === "minimax-m2p5-229b-w8a8")?.apiKey).toBe(
      "bundled-test-key"
    )
    expect(
      configs.find((config) => config.model === "deepseek-v4-flash-284b-a13b-w8a8")?.apiKey
    ).toBeUndefined()
  })

  it("uses remote values when provided and keeps credentials out of public config", async () => {
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "managed-model",
            name: "Managed",
            baseUrl: "https://llm.example.com/v1",
            model: "managed-model-v2",
            apiKey: "remote-key",
            temperature: 0.7,
            maxTokens: 200_000,
            tier: "premium"
          }
        ]
      }
    }

    await refreshBuiltinModelCatalog(true)
    expect(getBuiltinModelConfigs()[0]).toMatchObject({
      apiKey: "remote-key",
      temperature: 0.7,
      maxTokens: 200_000
    })
    const publicConfig = getBuiltinModelPublicConfigs()[0]
    expect(publicConfig.hasApiKey).toBe(true)
    expect(publicConfig).not.toHaveProperty("apiKey")
    expect(publicConfig.lockedFields).toEqual(["baseUrl", "model", "apiKey"])
  })

  it("stores only user fields that differ from the managed defaults", async () => {
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "managed-model",
            baseUrl: "https://llm.example.com/v1",
            model: "managed-model",
            temperature: 0.4
          }
        ]
      }
    }
    await refreshBuiltinModelCatalog(true)

    updateBuiltinModelOverride("managed-model", {
      name: "Local name",
      temperature: 0.4,
      maxTokens: 128_000
    })

    expect(state.overrides["managed-model"]).toEqual({ name: "Local name" })
    expect(getBuiltinModelConfigs()[0].name).toBe("Local name")
  })

  it("ignores a corrupted local override instead of hiding the managed model", async () => {
    await refreshBuiltinModelCatalog(true)
    state.overrides["minimax-m2p5-229b-w8a8"] = { maxTokens: "invalid" }

    expect(getBuiltinModelConfigs()[0]).toMatchObject({
      id: "minimax-m2p5-229b-w8a8",
      maxTokens: 128_000,
      origin: "fallback"
    })
  })

  it("keeps explicit custom and builtin references distinct when their IDs collide", async () => {
    await refreshBuiltinModelCatalog(true)
    state.customConfigs = [
      {
        id: "minimax-m2p5-229b-w8a8",
        name: "Custom collision",
        baseUrl: "https://custom.example.com/v1",
        model: "custom-collision-model",
        apiKey: "custom-key"
      }
    ]

    expect(getModelConfigByRef("custom:minimax-m2p5-229b-w8a8")).toMatchObject({
      source: "custom",
      model: "custom-collision-model"
    })
    expect(getModelConfigByRef("builtin:minimax-m2p5-229b-w8a8")).toMatchObject({
      source: "builtin",
      model: "minimax-m2p5-229b-w8a8"
    })
  })

  it("orders the saved custom default before managed models", async () => {
    await refreshBuiltinModelCatalog(true)
    state.customConfigs = [
      {
        id: "saved-default",
        name: "Saved Default",
        baseUrl: "https://custom.example.com/v1",
        model: "saved-default",
        apiKey: "custom-key"
      }
    ]
    state.storedDefault = "custom:saved-default"

    expect(getModelConfigs()[0]).toMatchObject({
      ref: "custom:saved-default",
      source: "custom"
    })
    expect(getDefaultModelConfig()).toMatchObject({ ref: "custom:saved-default" })
  })

  it("falls back to the saved available model when a pinned model was removed", async () => {
    await refreshBuiltinModelCatalog(true)
    state.customConfigs = [
      {
        id: "chatx-default",
        name: "ChatX Default",
        baseUrl: "https://custom.example.com/v1",
        model: "chatx-default",
        apiKey: "custom-key"
      }
    ]
    state.storedDefault = "custom:chatx-default"

    expect(getAvailableModelConfigOrDefault("builtin:removed")).toMatchObject({
      ref: "custom:chatx-default",
      source: "custom"
    })
  })

  it("rejects zero-valued sampling parameters consistently", async () => {
    await refreshBuiltinModelCatalog(true)

    expect(() => updateBuiltinModelOverride("minimax-m2p5-229b-w8a8", { temperature: 0 })).toThrow(
      "(0, 2]"
    )
    expect(() => updateBuiltinModelOverride("minimax-m2p5-229b-w8a8", { topP: 0 })).toThrow(
      "(0, 1]"
    )
    expect(() =>
      updateBuiltinModelOverride("minimax-m2p5-229b-w8a8", {
        enableThinking: "false" as unknown as boolean
      })
    ).toThrow("true 或 false")
  })

  it("keeps the last good remote catalog when a refresh is malformed", async () => {
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "last-good",
            baseUrl: "https://llm.example.com/v1",
            model: "last-good"
          }
        ]
      }
    }
    await refreshBuiltinModelCatalog(true)

    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "invalid",
            baseUrl: "https://llm.example.com/v1",
            model: "invalid",
            temperature: 0
          }
        ]
      }
    }
    await refreshBuiltinModelCatalog(true)

    expect(getBuiltinModelConfigs()[0]).toMatchObject({ id: "last-good", origin: "remote" })
  })

  it("returns to the local fallback when the update source is removed", async () => {
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "temporary-remote",
            baseUrl: "https://llm.example.com/v1",
            model: "temporary-remote"
          }
        ]
      }
    }
    await refreshBuiltinModelCatalog(true)
    expect(getBuiltinModelConfigs()[0].id).toBe("temporary-remote")

    state.sourceBaseUrl = ""
    await refreshBuiltinModelCatalog(true)

    expect(getBuiltinModelConfigs().map((item) => item.origin)).toEqual(["fallback", "fallback"])
  })
})
