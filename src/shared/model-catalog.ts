import { IDLE_MODEL_OUTSIDE_HOURS_MESSAGE, IDLE_MODEL_SERVICE_HOURS } from "./idle-model-service-window"

export type ModelInputModality = "text" | "image"

export function modelInputModalities(value: unknown): ModelInputModality[] {
  return Array.isArray(value) && value.includes("image") ? ["text", "image"] : ["text"]
}

export type ModelTier = "premium" | "economy"
export type ModelThinkingEffort = "low" | "high" | "max"
export type ModelTransport = "idle-gateway"
export type IdleModelEnvironment = "production" | "uat"
export type BuiltinModelLockedField = "baseUrl" | "model" | "apiKey" | "maxTokens"

// Pro already uses this persisted ID in defaults, overrides and thread metadata.
export const MAODOU_PRO_MODEL_ID = "idle-ultra"
export const MAODOU_PRO_MODEL_NAME = "码豆模型PRO"
export const IDLE_ULTRA_MODEL_ID = "maodou-ultra"
export const IDLE_ULTRA_MODEL_NAME = "闲时模型 Ultra"
export const IDLE_MODEL_MAX_TOKENS = 128_000
export const IDLE_MODEL_UAT_DEFAULT_MAX_TOKENS = 200_000
export const IDLE_MODEL_SAP_REQUIRED_MESSAGE = "请先完善当前用户的八位 SAP 员工编号"
export const IDLE_MODEL_NOTICE = `生产环境服务时间为${IDLE_MODEL_SERVICE_HOURS}。可以提前选择模型。`
export const IDLE_MODEL_UAT_NOTICE = "当前使用 UAT 测试环境。"

export function isValidSapId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length === 8
}

export function isModelAvailable<T extends { apiKey?: string; unavailableReason?: string }>(
  config: T | null | undefined
): config is T {
  return Boolean(config?.apiKey) && !config?.unavailableReason
}

/** A configured gateway model can be pinned before its service window opens. */
export function isModelSelectable(
  config: { apiKey?: string; transport?: ModelTransport; unavailableReason?: string }
): boolean {
  return (
    Boolean(config.apiKey) &&
    (!config.unavailableReason ||
      (config.transport === "idle-gateway" &&
        config.unavailableReason === IDLE_MODEL_OUTSIDE_HOURS_MESSAGE))
  )
}

/**
 * Optional model catalog embedded in the remote update manifest.
 * Only baseUrl and model are required. Every other field falls back to the
 * client-side preset for that model.
 */
export interface RemoteModelCatalogItem {
  inputModalities?: ModelInputModality[]
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
