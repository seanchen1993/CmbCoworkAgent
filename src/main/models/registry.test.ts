import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveLegacyBotWorkModelRef } from "../../shared/bots/model-policy"

const state = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  overrides: {} as Record<string, Record<string, unknown>>,
  customConfigs: [] as Array<Record<string, unknown>>,
  storedDefault: "",
  sourceBaseUrl: "https://updates.example.com",
  localApiKey: "local-test-key",
  bundledApiKey: "bundled-test-key",
  sapId: "12345678" as string | undefined,
  idleModelUseUat: false,
  fetchGate: null as Promise<void> | null,
  send: vi.fn()
}))

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: state.send }
      }
    ]
  }
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
  getStoredDefaultModelId: () => state.storedDefault,
  getStoredIdleModelUseUat: () => state.idleModelUseUat,
  getUserInfo: () => ({ sapId: state.sapId })
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
  getModelByTier,
  refreshBuiltinModelCatalog,
  resetBuiltinModelOverride,
  startBuiltinModelCatalogRefresh,
  stopBuiltinModelCatalogRefresh,
  updateBuiltinModelOverride
} from "./registry"

beforeEach(() => {
  vi.stubEnv("MAIN_VITE_IDLE_MODEL_PROD_BASE_URL", "")
  vi.stubEnv("MAIN_VITE_IDLE_MODEL_PROD_API_KEY", "")
  vi.stubEnv("MAIN_VITE_IDLE_MODEL_UAT_BASE_URL", "")
  vi.stubEnv("MAIN_VITE_IDLE_MODEL_UAT_API_KEY", "")
  state.idleModelUseUat = false
  state.sapId = "12345678"
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
  vi.useFakeTimers({ toFake: ["Date"] })
  state.send.mockClear()
})

afterEach(() => {
  stopBuiltinModelCatalogRefresh()
  vi.useRealTimers()
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

  function configureIdleModel() {
    vi.stubEnv("MAIN_VITE_IDLE_MODEL_PROD_BASE_URL", "http://idle.example.test/pattern/llm/v1")
    vi.stubEnv("MAIN_VITE_IDLE_MODEL_PROD_API_KEY", "idle-test-key")
    vi.stubEnv("MAIN_VITE_IDLE_MODEL_UAT_BASE_URL", "http://idle-uat.example.test/pattern/llm/v1")
    vi.stubEnv("MAIN_VITE_IDLE_MODEL_UAT_API_KEY", "idle-uat-test-key")
  }

  it("defaults to production and switches the idle URL and credential together", () => {
    configureIdleModel()
    expect(getModelConfigByRef("builtin:idle-ultra")).toMatchObject({
      baseUrl: "http://idle.example.test/pattern/llm/v1",
      apiKey: "idle-test-key",
      model: "pro",
      idleModelEnvironment: "production",
      enableThinking: true,
      enableThinkingEffort: true,
      thinkingEffort: "high"
    })
    state.idleModelUseUat = true
    expect(getModelConfigByRef("builtin:idle-ultra")).toMatchObject({
      baseUrl: "http://idle-uat.example.test/pattern/llm/v1",
      apiKey: "idle-uat-test-key",
      idleModelEnvironment: "uat",
      model: "pro",
      enableThinking: true,
      enableThinkingEffort: true,
      thinkingEffort: "high",
      notice: "当前使用 UAT 测试环境。",
      maxTokens: 200_000
    })
    state.idleModelUseUat = false
    expect(getModelConfigByRef("builtin:idle-ultra")?.apiKey).toBe("idle-test-key")
    expect(getModelConfigByRef("ultra")?.ref).toBe("builtin:idle-ultra")
  })

  it("keeps saved Pro thinking overrides", () => {
    configureIdleModel()
    updateBuiltinModelOverride("idle-ultra", {
      enableThinking: false,
      thinkingEffort: "max"
    })
    expect(getModelConfigByRef("builtin:idle-ultra")).toMatchObject({
      enableThinking: false,
      enableThinkingEffort: false,
      thinkingEffort: "max"
    })
  })

  it.each([false, true])("does not borrow credentials across environments (UAT %s)", (useUat) => {
    configureIdleModel()
    state.idleModelUseUat = useUat
    vi.stubEnv(
      useUat ? "MAIN_VITE_IDLE_MODEL_UAT_API_KEY" : "MAIN_VITE_IDLE_MODEL_PROD_API_KEY",
      ""
    )
    expect(getModelConfigByRef("builtin:idle-ultra")?.apiKey).toBeUndefined()
    expect(getBuiltinModelPublicConfigs().find((item) => item.id === "idle-ultra")?.hasApiKey).toBe(
      false
    )
  })

  it.each([false, true])("does not fall back to another environment's URL (UAT %s)", (useUat) => {
    configureIdleModel()
    state.idleModelUseUat = useUat
    vi.stubEnv(
      useUat ? "MAIN_VITE_IDLE_MODEL_UAT_BASE_URL" : "MAIN_VITE_IDLE_MODEL_PROD_BASE_URL",
      ""
    )
    expect(getModelConfigByRef("builtin:idle-ultra")).toBeNull()
  })

  it("retains the independent idle model alongside remote models with fixed pro and 128k", async () => {
    configureIdleModel()
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "idle-ultra",
            name: "Remote collision",
            model: "remote-model",
            baseUrl: "https://other.example.test/v1"
          }
        ]
      }
    }
    await refreshBuiltinModelCatalog(true)
    expect(getBuiltinModelConfigs().filter((item) => item.id === "idle-ultra")).toEqual([
      expect.objectContaining({
        name: "码豆模型PRO",
        model: "pro",
        maxTokens: 128_000,
        apiKey: "idle-test-key",
        transport: "idle-gateway",
        origin: "local"
      })
    ])
    const idle = getBuiltinModelPublicConfigs().find((item) => item.id === "idle-ultra")!
    expect(idle.lockedFields).toContain("maxTokens")
    expect(idle.notice).toBeUndefined()
    expect(idle).not.toHaveProperty("apiKey")
    expect(() => updateBuiltinModelOverride("idle-ultra", { maxTokens: 256_000 })).toThrow(
      "固定为 128k"
    )
    state.overrides["idle-ultra"] = { maxTokens: 256_000 }
    expect(getModelConfigByRef("builtin:idle-ultra")?.maxTokens).toBe(128_000)
  })

  it("does not reuse another built-in model's credential for the idle gateway", () => {
    configureIdleModel()
    vi.stubEnv("MAIN_VITE_IDLE_MODEL_PROD_API_KEY", "")
    expect(getModelConfigByRef("builtin:idle-ultra")?.apiKey).toBeUndefined()
  })

  it("saves an editable UAT context window separately from production's fixed window", () => {
    configureIdleModel()
    const id = "idle-ultra"
    const ref = "builtin:idle-ultra"
    state.idleModelUseUat = true
    expect(getBuiltinModelPublicConfigs().find((model) => model.id === id)).toMatchObject({
      maxTokens: 200_000,
      lockedFields: ["baseUrl", "model", "apiKey"]
    })
    expect(() => updateBuiltinModelOverride(id, { maxTokens: 31_999 })).toThrow("32000~1000000")
    expect(() =>
      updateBuiltinModelOverride(id, { maxTokens: 32_000, maxOutputTokens: 28_000 })
    ).toThrow("compaction trigger")
    updateBuiltinModelOverride(id, { maxTokens: 256_000 })
    expect(getAvailableModelConfigOrDefault(ref)?.maxTokens).toBe(256_000)

    state.idleModelUseUat = false
    expect(getBuiltinModelPublicConfigs().find((model) => model.id === id)).toMatchObject({
      maxTokens: 128_000,
      lockedFields: ["baseUrl", "model", "apiKey", "maxTokens"]
    })
    updateBuiltinModelOverride(id, { maxTokens: 128_000, temperature: 0.3 })
    expect(state.overrides[id]).toEqual({ maxTokens: 256_000, temperature: 0.3 })
    resetBuiltinModelOverride(id)
    expect(state.overrides[id]).toEqual({ maxTokens: 256_000 })

    state.idleModelUseUat = true
    expect(getAvailableModelConfigOrDefault(ref)?.maxTokens).toBe(256_000)
    resetBuiltinModelOverride(id)
    expect(getAvailableModelConfigOrDefault(ref)?.maxTokens).toBe(200_000)
  })

  it("prefers Pro before MiniMax while honoring saved defaults and availability", async () => {
    await refreshBuiltinModelCatalog(true)
    configureIdleModel()
    const proRef = "builtin:idle-ultra"
    const minimaxRef = "builtin:minimax-m2p5-229b-w8a8"

    expect(getBuiltinModelPublicConfigs().map((model) => model.ref)).toEqual([proRef, minimaxRef])
    expect(getModelConfigs()[0]?.ref).toBe(proRef)
    expect(getDefaultModelConfig()?.ref).toBe(proRef)
    expect(getModelByTier("premium")?.ref).toBe(proRef)
    expect(getAvailableModelConfigOrDefault(minimaxRef)?.ref).toBe(minimaxRef)

    state.storedDefault = minimaxRef
    expect(getDefaultModelConfig()?.ref).toBe(minimaxRef)
    expect(getModelByTier("premium")?.ref).toBe(minimaxRef)
    state.storedDefault = ""

    state.sapId = undefined
    expect(getDefaultModelConfig()?.ref).toBe(minimaxRef)
    expect(getModelByTier("premium")?.ref).toBe(minimaxRef)
  })

  it.each([false, true])("keeps Pro available all day with a letter-only SAP ID (UAT %s)", (useUat) => {
    configureIdleModel()
    state.idleModelUseUat = useUat
    state.sapId = "ABCDEFGH"
    state.storedDefault = "builtin:idle-ultra"
    for (const hour of ["00", "07", "12", "21", "22"]) {
      vi.setSystemTime(new Date(`2026-10-28T${hour}:00:00+08:00`))
      expect(getAvailableModelConfigOrDefault("builtin:idle-ultra")?.model).toBe("pro")
      expect(getAvailableModelConfigOrDefault()?.id).toBe("idle-ultra")
      expect(getModelByTier("premium")?.id).toBe("idle-ultra")
    }
    state.sapId = undefined
    expect(getModelConfigByRef("builtin:idle-ultra")?.unavailableReason).toContain("SAP")
    expect(getAvailableModelConfigOrDefault("builtin:idle-ultra")?.id).not.toBe("idle-ultra")
    expect(getDefaultModelConfig()?.id).toBe("idle-ultra")
  })
  it("uses MiniMax as the only local fallback when the manifest has no catalog", async () => {
    await refreshBuiltinModelCatalog(true)
    const configs = getBuiltinModelConfigs()

    expect(configs.map((item) => item.ref)).toEqual(["builtin:minimax-m2p5-229b-w8a8"])
    expect(configs[0]).toMatchObject({
      temperature: 1,
      enableThinking: true,
      interleavedThinking: true,
      tier: "premium",
      origin: "fallback"
    })
    expect(configs[0].apiKey).toBe("local-test-key")
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
    state.manifest = {
      modelCatalog: {
        schemaVersion: 1,
        models: [
          {
            id: "minimax-m2p5-229b-w8a8",
            baseUrl: "https://llm.example.test/minimax/v1",
            model: "minimax-m2p5-229b-w8a8"
          },
          {
            id: "deepseek-v4-flash-284b-a13b-w8a8",
            baseUrl: "https://llm.example.test/deepseek/v1",
            model: "deepseek-v4-flash-284b-a13b-w8a8"
          }
        ]
      }
    }
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

  it("keeps Bot legacy alias restoration consistent with execution when the display default reorders providers", async () => {
    await refreshBuiltinModelCatalog(true)
    const configs = [
      { id: "provider-a", model: "same-api-model", apiKey: "a", name: "A", baseUrl: "https://a.example.com" },
      { id: "provider-b", model: "same-api-model", apiKey: "b", name: "B", baseUrl: "https://b.example.com" }
    ]
    state.customConfigs = configs
    state.storedDefault = "custom:provider-b"
    expect(getModelConfigs()[0].ref).toBe("custom:provider-b")
    const restored = resolveLegacyBotWorkModelRef("custom:same-api-model", configs)
    expect(restored).toBe("custom:provider-a")
    expect(getModelConfigByRef(restored)).toEqual(getModelConfigByRef("custom:same-api-model"))
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

  it("rejects builtin overrides whose output budget prevents compaction", async () => {
    await refreshBuiltinModelCatalog(true)

    expect(() =>
      updateBuiltinModelOverride("minimax-m2p5-229b-w8a8", {
        maxTokens: 32_000,
        maxOutputTokens: 28_000
      })
    ).toThrow("compaction trigger 3000 must exceed retained context 3200")
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

    expect(getBuiltinModelConfigs().map((item) => item.origin)).toEqual(["fallback"])
  })
})
