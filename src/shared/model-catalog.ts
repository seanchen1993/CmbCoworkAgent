export type ModelTier = "premium" | "economy"
export type ModelThinkingEffort = "low" | "high" | "max"
export type ModelTransport = "idle-gateway"
export type BuiltinModelLockedField = "baseUrl" | "model" | "apiKey" | "maxTokens"

export const IDLE_MODEL_ID = "idle-ultra"
export const IDLE_MODEL_MODE = "ultra"
export const IDLE_MODEL_MAX_TOKENS = 128_000
export const IDLE_MODEL_NOTICE =
  "闲时服务时间：22:00–次日 07:00（北京时间），其他时段也可选择，服务可用性以网关为准。"

export function isValidSapId(value: unknown): value is string {
  return typeof value === "string" && /^\d{8}$/.test(value.trim())
}

export function isModelAvailable<T extends { apiKey?: string; unavailableReason?: string }>(
  config: T | null | undefined
): config is T {
  return Boolean(config?.apiKey) && !config?.unavailableReason
}

/**
 * Optional model catalog embedded in the remote update manifest.
 * Only baseUrl and model are required. Every other field falls back to the
 * client-side preset for that model.
 */
export interface RemoteModelCatalogItem {
  id?: string
  enabled?: boolean
  name?: string
  baseUrl: string
  model: string
  apiKey?: string
  maxTokens?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  interleavedThinking?: boolean
  enableThinking?: boolean
  enableThinkingEffort?: boolean
  thinkingEffort?: ModelThinkingEffort
  tier?: ModelTier
}

export interface RemoteModelCatalog {
  schemaVersion: 1
  revision?: string
  models: RemoteModelCatalogItem[]
}
