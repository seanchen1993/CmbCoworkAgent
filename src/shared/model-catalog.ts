export type ModelTier = "premium" | "economy"
export type ModelThinkingEffort = "high" | "max"

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
