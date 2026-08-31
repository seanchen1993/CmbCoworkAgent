import { BrowserWindow } from "electron"
import type { RemoteModelCatalog, RemoteModelCatalogItem } from "../../shared/model-catalog"
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_THINKING_EFFORT,
  DEFAULT_TOP_K,
  DEFAULT_TOP_P,
  MAX_MAX_OUTPUT_TOKENS,
  MAX_MAX_TOKENS,
  MAX_TEMPERATURE,
  MAX_TOP_K,
  MAX_TOP_P,
  MIN_MAX_OUTPUT_TOKENS,
  MIN_MAX_TOKENS,
  MIN_TOP_K,
  getBuiltinModelApiKey,
  getBuiltinModelOverrides,
  getCustomModelConfigs,
  getStoredDefaultModelId,
  resetBuiltinModelOverride as resetStoredBuiltinModelOverride,
  setStoredDefaultModelId,
  setBuiltinModelOverride as setStoredBuiltinModelOverride,
  type BuiltinModelOverride,
  type CustomModelConfig
} from "../storage"
import { fetchLatestJson } from "../updater/checker"
import { resolveUpdateSource } from "../updater/channel-config"
import { calculateSummarizationTriggerTokens } from "../../shared/model-token-budget"
import { getHiddenEndpoint } from "../security/hidden-endpoints"

export type ModelSource = "builtin" | "custom"
export type BuiltinModelOrigin = "remote" | "fallback"
export type ModelRef = `builtin:${string}` | `custom:${string}`

export interface ResolvedModelConfig extends CustomModelConfig {
  ref: ModelRef
  source: ModelSource
  origin?: BuiltinModelOrigin
}

export interface BuiltinModelPublicConfig extends Omit<ResolvedModelConfig, "apiKey"> {
  source: "builtin"
  hasApiKey: boolean
  lockedFields: Array<"baseUrl" | "model" | "apiKey">
}

interface BuiltinModelDefinition extends CustomModelConfig {
  source: "builtin"
  origin: BuiltinModelOrigin
}

const BUNDLED_CREDENTIAL_MODEL = "minimax-m2p5-229b-w8a8"

const FALLBACK_CATALOG: RemoteModelCatalogItem[] = [
  {
    id: "minimax-m2p5-229b-w8a8",
    name: "MiniMax M2.5",
    baseUrl: getHiddenEndpoint("modelMinimax"),
    model: "minimax-m2p5-229b-w8a8",
    tier: "premium"
  }
]

const MODEL_CATALOG_REFRESH_MS = 30 * 60 * 1000
let remoteDefinitions: BuiltinModelDefinition[] | null = null
let catalogLoaded = false
let catalogRequest: Promise<void> | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

function notifyModelChanges(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("models:changed")
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function requireUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("baseUrl 不能为空")
  const normalized = value.trim()
  const parsed = new URL(normalized)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl 必须使用 http/https")
  }
  return normalized
}

function optionalNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = false,
  exclusiveMin = false
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("模型数值参数必须是有限数字")
  }
  const normalized = integer ? Math.floor(value) : value
  if ((exclusiveMin ? normalized <= min : normalized < min) || normalized > max) {
    throw new Error(`模型数值参数超出范围 ${exclusiveMin ? `(${min}, ${max}]` : `${min}~${max}`}`)
  }
  return normalized
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "boolean") throw new Error("模型布尔参数必须是 true 或 false")
  return value
}

function modelPreset(
  model: string
): Required<
  Pick<
    CustomModelConfig,
    | "maxTokens"
    | "maxOutputTokens"
    | "temperature"
    | "topP"
    | "topK"
    | "interleavedThinking"
    | "enableThinking"
    | "enableThinkingEffort"
    | "thinkingEffort"
    | "tier"
  >
> {
  const isMiniMax = /minimax/i.test(model)
  const isDeepSeekFlash = /deepseek.*flash/i.test(model)
  return {
    maxTokens: DEFAULT_MAX_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: isMiniMax ? 1 : DEFAULT_TEMPERATURE,
    topP: DEFAULT_TOP_P,
    topK: DEFAULT_TOP_K,
    enableThinking: isMiniMax,
    enableThinkingEffort: false,
    interleavedThinking: isMiniMax,
    thinkingEffort: DEFAULT_THINKING_EFFORT,
    tier: isDeepSeekFlash ? "economy" : "premium"
  }
}

function normalizeDefinition(
  item: RemoteModelCatalogItem,
  origin: BuiltinModelOrigin
): BuiltinModelDefinition {
  if (!item || typeof item !== "object") throw new Error("模型配置必须是对象")
  const model = typeof item.model === "string" ? item.model.trim() : ""
  if (!model) throw new Error("model 不能为空")
  const id = (typeof item.id === "string" ? item.id.trim() : "") || slugify(model)
  if (!id) throw new Error("无法生成稳定模型 ID")
  const preset = modelPreset(model)
  const enableThinking = optionalBoolean(item.enableThinking, preset.enableThinking)
  const enableThinkingEffort =
    enableThinking && optionalBoolean(item.enableThinkingEffort, preset.enableThinkingEffort)
  const interleavedThinking =
    enableThinking && optionalBoolean(item.interleavedThinking, preset.interleavedThinking)
  const apiKey =
    typeof item.apiKey === "string" && item.apiKey.trim() ? item.apiKey.trim() : undefined

  const definition: BuiltinModelDefinition = {
    id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : model,
    baseUrl: requireUrl(item.baseUrl),
    model,
    apiKey,
    maxTokens: optionalNumber(
      item.maxTokens,
      preset.maxTokens,
      MIN_MAX_TOKENS,
      MAX_MAX_TOKENS,
      true
    ),
    maxOutputTokens: optionalNumber(
      item.maxOutputTokens,
      preset.maxOutputTokens,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
      true
    ),
    temperature: optionalNumber(
      item.temperature,
      preset.temperature,
      0,
      MAX_TEMPERATURE,
      false,
      true
    ),
    topP: optionalNumber(item.topP, preset.topP, 0, MAX_TOP_P, false, true),
    topK: optionalNumber(item.topK, preset.topK, MIN_TOP_K, MAX_TOP_K, true),
    enableThinking,
    enableThinkingEffort,
    interleavedThinking,
    thinkingEffort: item.thinkingEffort === "max" ? "max" : preset.thinkingEffort,
    tier: item.tier === "economy" ? "economy" : item.tier === "premium" ? "premium" : preset.tier,
    source: "builtin",
    origin
  }
  calculateSummarizationTriggerTokens(definition.maxTokens!, definition.maxOutputTokens!)
  return definition
}

function normalizeCatalog(catalog: unknown): BuiltinModelDefinition[] | null {
  if (!catalog || typeof catalog !== "object") return null
  const raw = catalog as Partial<RemoteModelCatalog>
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.models) || raw.models.length === 0) {
    return null
  }
  for (const item of raw.models) {
    if (item?.enabled !== undefined && typeof item.enabled !== "boolean") {
      throw new Error("模型 enabled 参数必须是 true 或 false")
    }
  }
  const enabled = raw.models.filter((item) => item?.enabled !== false)
  if (enabled.length === 0) return null
  const definitions = enabled.map((item) => normalizeDefinition(item, "remote"))
  const ids = new Set<string>()
  for (const item of definitions) {
    if (ids.has(item.id)) throw new Error(`内置模型 ID 重复: ${item.id}`)
    ids.add(item.id)
  }
  return definitions
}

function getBaseDefinitions(): BuiltinModelDefinition[] {
  if (remoteDefinitions?.length) return remoteDefinitions
  return FALLBACK_CATALOG.map((item) => normalizeDefinition(item, "fallback"))
}

function normalizeOverride(
  override: BuiltinModelOverride | undefined,
  base: BuiltinModelDefinition
): BuiltinModelOverride {
  if (!override) return {}
  const enableThinking = optionalBoolean(override.enableThinking, base.enableThinking ?? false)
  const normalized: BuiltinModelOverride = {
    ...(typeof override.name === "string" && override.name.trim()
      ? { name: override.name.trim() }
      : {}),
    maxTokens: optionalNumber(
      override.maxTokens,
      base.maxTokens!,
      MIN_MAX_TOKENS,
      MAX_MAX_TOKENS,
      true
    ),
    maxOutputTokens: optionalNumber(
      override.maxOutputTokens,
      base.maxOutputTokens!,
      MIN_MAX_OUTPUT_TOKENS,
      MAX_MAX_OUTPUT_TOKENS,
      true
    ),
    temperature: optionalNumber(
      override.temperature,
      base.temperature!,
      0,
      MAX_TEMPERATURE,
      false,
      true
    ),
    topP: optionalNumber(override.topP, base.topP!, 0, MAX_TOP_P, false, true),
    topK: optionalNumber(override.topK, base.topK!, MIN_TOP_K, MAX_TOP_K, true),
    enableThinking,
    enableThinkingEffort:
      enableThinking &&
      optionalBoolean(override.enableThinkingEffort, base.enableThinkingEffort ?? false),
    interleavedThinking:
      enableThinking &&
      optionalBoolean(override.interleavedThinking, base.interleavedThinking ?? false),
    thinkingEffort: override.thinkingEffort === "max" ? "max" : base.thinkingEffort,
    tier:
      override.tier === "economy" ? "economy" : override.tier === "premium" ? "premium" : base.tier
  }
  calculateSummarizationTriggerTokens(normalized.maxTokens!, normalized.maxOutputTokens!)
  return normalized
}

export function getBuiltinModelConfigs(): ResolvedModelConfig[] {
  const overrides = getBuiltinModelOverrides()
  return getBaseDefinitions().map((base) => {
    let override: BuiltinModelOverride = {}
    try {
      override = normalizeOverride(overrides[base.id], base)
    } catch (error) {
      console.warn(`[Models] Ignoring invalid local override for ${base.id}:`, error)
    }
    return {
      ...base,
      ...override,
      apiKey:
        base.apiKey?.trim() ||
        getBuiltinModelApiKey({ allowBundledFallback: base.model === BUNDLED_CREDENTIAL_MODEL }),
      ref: `builtin:${base.id}`,
      source: "builtin",
      origin: base.origin
    }
  })
}

export function getBuiltinModelPublicConfigs(): BuiltinModelPublicConfig[] {
  return getBuiltinModelConfigs().map(({ apiKey, ...config }) => ({
    ...config,
    source: "builtin",
    hasApiKey: Boolean(apiKey),
    lockedFields: ["baseUrl", "model", "apiKey"]
  }))
}

function collectModelConfigs(): ResolvedModelConfig[] {
  const custom = getCustomModelConfigs().map(
    (config): ResolvedModelConfig => ({
      ...config,
      ref: `custom:${config.id}`,
      source: "custom"
    })
  )
  return [...getBuiltinModelConfigs(), ...custom]
}

function resolveModelConfigFromList(
  configs: ResolvedModelConfig[],
  value: string | undefined | null
): ResolvedModelConfig | null {
  const raw = value?.trim()
  if (!raw) return null
  if (raw.startsWith("builtin:")) {
    const id = raw.slice("builtin:".length)
    return configs.find((config) => config.source === "builtin" && config.id === id) ?? null
  }
  if (raw.startsWith("custom:")) {
    const id = raw.slice("custom:".length)
    return (
      configs.find((config) => config.source === "custom" && config.id === id) ??
      configs.find((config) => config.source === "custom" && config.model === id) ??
      null
    )
  }
  return (
    configs.find((config) => config.source === "custom" && config.id === raw) ??
    configs.find((config) => config.source === "custom" && config.model === raw) ??
    configs.find((config) => config.id === raw || config.model === raw) ??
    null
  )
}

/** All effective models, with the saved default first for list consumers. */
export function getModelConfigs(): ResolvedModelConfig[] {
  const configs = collectModelConfigs()
  const selectedDefault =
    resolveModelConfigFromList(configs, getStoredDefaultModelId()) ??
    configs.find((config) => Boolean(config.apiKey)) ??
    configs[0]
  if (!selectedDefault) return configs
  const defaultRef = toModelRef(selectedDefault)
  return [selectedDefault, ...configs.filter((config) => toModelRef(config) !== defaultRef)]
}

export function toModelRef(config: Pick<ResolvedModelConfig, "id" | "source">): ModelRef {
  return `${config.source}:${config.id}`
}

export function getModelConfigByRef(value: string | undefined | null): ResolvedModelConfig | null {
  return resolveModelConfigFromList(collectModelConfigs(), value)
}

export function normalizeModelRef(value: string): ModelRef | "" {
  const resolved = getModelConfigByRef(value)
  return resolved ? toModelRef(resolved) : ""
}

export function setDefaultModelRef(value: string): ModelRef | "" {
  const normalized = normalizeModelRef(value)
  setStoredDefaultModelId(normalized)
  notifyModelChanges()
  return normalized
}

export function getDefaultModelConfig(): ResolvedModelConfig | null {
  const configs = collectModelConfigs()
  if (configs.length === 0) return null
  return (
    resolveModelConfigFromList(configs, getStoredDefaultModelId()) ??
    configs.find((config) => Boolean(config.apiKey)) ??
    configs[0] ??
    null
  )
}

/** Resolve a requested model, falling back to the saved/default available model. */
export function getAvailableModelConfigOrDefault(
  value?: string | null
): ResolvedModelConfig | null {
  const requested = getModelConfigByRef(value)
  if (requested?.apiKey) return requested
  const selectedDefault = getDefaultModelConfig()
  if (selectedDefault?.apiKey) return selectedDefault
  return getModelConfigs().find((config) => Boolean(config.apiKey)) ?? null
}

export function getModelByTier(tier: "premium" | "economy"): ResolvedModelConfig | null {
  const configs = getModelConfigs().filter((config) => Boolean(config.apiKey))
  return configs.find((config) => (config.tier ?? "premium") === tier) ?? configs[0] ?? null
}

export function updateBuiltinModelOverride(id: string, input: BuiltinModelOverride): void {
  const base = getBaseDefinitions().find((item) => item.id === id)
  if (!base) throw new Error("未找到内置模型")
  const normalized = normalizeOverride(input, base)
  const diff: BuiltinModelOverride = {}
  const keys: Array<keyof BuiltinModelOverride> = [
    "name",
    "maxTokens",
    "maxOutputTokens",
    "temperature",
    "topP",
    "topK",
    "interleavedThinking",
    "enableThinking",
    "enableThinkingEffort",
    "thinkingEffort",
    "tier"
  ]
  for (const key of keys) {
    if (normalized[key] !== undefined && normalized[key] !== base[key]) {
      ;(diff as Record<string, unknown>)[key] = normalized[key]
    }
  }
  if (Object.keys(diff).length === 0) {
    resetStoredBuiltinModelOverride(id)
  } else {
    setStoredBuiltinModelOverride(id, diff)
  }
  notifyModelChanges()
}

export function resetBuiltinModelOverride(id: string): void {
  if (!getBaseDefinitions().some((item) => item.id === id)) throw new Error("未找到内置模型")
  resetStoredBuiltinModelOverride(id)
  notifyModelChanges()
}

function catalogSignature(): string {
  return JSON.stringify(
    getBaseDefinitions().map((item) => ({ ...item, apiKey: item.apiKey ? "<configured>" : "" }))
  )
}

export async function refreshBuiltinModelCatalog(force = false): Promise<void> {
  if (!force && catalogLoaded) return
  if (catalogRequest) return catalogRequest
  const request = (async () => {
    const previous = catalogSignature()
    const defaultBaseUrl = (import.meta.env.VITE_UPDATE_SERVER_URL as string | undefined) || ""
    const source = resolveUpdateSource(defaultBaseUrl)
    if (!source.baseUrl) {
      catalogLoaded = true
      remoteDefinitions = null
      if (previous !== catalogSignature()) notifyModelChanges()
      return
    }
    try {
      const manifest = await fetchLatestJson(source.baseUrl, source.manifestFile)
      remoteDefinitions = normalizeCatalog(manifest.modelCatalog)
      catalogLoaded = true
      const next = catalogSignature()
      if (previous !== next) {
        notifyModelChanges()
      }
      console.log(
        `[Models] Catalog loaded: source=${remoteDefinitions ? "remote" : "fallback"} models=${getBaseDefinitions().length}`
      )
    } catch (error) {
      catalogLoaded = true
      console.warn(
        "[Models] Failed to refresh remote model catalog; keeping current catalog:",
        error
      )
    }
  })()
  catalogRequest = request
  try {
    await request
  } finally {
    if (catalogRequest === request) catalogRequest = null
  }
}

export function startBuiltinModelCatalogRefresh(): Promise<void> {
  const initialRefresh = refreshBuiltinModelCatalog()
  if (refreshTimer) return initialRefresh
  refreshTimer = setInterval(() => void refreshBuiltinModelCatalog(true), MODEL_CATALOG_REFRESH_MS)
  return initialRefresh
}

export function stopBuiltinModelCatalogRefresh(): void {
  if (!refreshTimer) return
  clearInterval(refreshTimer)
  refreshTimer = null
}
