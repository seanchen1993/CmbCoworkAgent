import { IDLE_MODEL_OUTSIDE_HOURS_MESSAGE } from "./idle-model-service-window"

export type ModelTier = "premium" | "economy"
export type ModelThinkingEffort = "low" | "high" | "max"
export type ModelTransport = "idle-gateway"
export type BuiltinModelLockedField = "baseUrl" | "model" | "apiKey" | "maxTokens"

export const IDLE_MODEL_ID = "idle-ultra"
export const IDLE_MODEL_MODE = "ultra"
export const IDLE_MODEL_MAX_TOKENS = 128_000
export const IDLE_MODEL_SAP_REQUIRED_MESSAGE = "请先完善当前用户的八位 SAP 员工编号"
export const IDLE_MODEL_NOTICE =
  "闲时服务时间：22:00–次日 07:00（北京时间）。可提前选择，非服务时段禁止调用；已发出的请求可完成，后续请求需等待下一开放时段。"

export function isValidSapId(value: unknown): value is string {
  return typeof value === "string" && /^\d{8}$/.test(value.trim())
}

export function isModelAvailable<T extends { apiKey?: string; unavailableReason?: string }>(
  config: T | null | undefined
): config is T {
  return Boolean(config?.apiKey) && !config?.unavailableReason
}

/** A configured idle model may be pinned before its service window opens. */
export function isModelSelectable(
  config:
    | { apiKey?: string; transport?: ModelTransport; unavailableReason?: string }
    | null
    | undefined
): boolean {
  return (
    Boolean(config?.apiKey) &&
    (!config?.unavailableReason ||
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
