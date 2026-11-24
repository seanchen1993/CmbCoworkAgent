export type ModelTier = "premium" | "economy"
export type ModelThinkingEffort = "low" | "high" | "max"
export type ModelTransport = "idle-gateway"
export type IdleModelEnvironment = "production" | "uat"
export type BuiltinModelLockedField = "baseUrl" | "model" | "apiKey" | "maxTokens"

// Keep the persisted ID for existing defaults, overrides and thread metadata.
export const IDLE_MODEL_ID = "idle-ultra"
export const IDLE_MODEL_NAME = "码豆模型PRO"
export const IDLE_MODEL_MODE = "pro"
export const IDLE_MODEL_MAX_TOKENS = 128_000
export const IDLE_MODEL_UAT_DEFAULT_MAX_TOKENS = 200_000
export const IDLE_MODEL_SAP_REQUIRED_MESSAGE = "请先完善当前用户的八位 SAP 员工编号"
export const IDLE_MODEL_UAT_NOTICE = "当前使用 UAT 测试环境。"

export function isValidSapId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length === 8
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
