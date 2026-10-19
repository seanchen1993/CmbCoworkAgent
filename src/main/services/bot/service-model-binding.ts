import { createHash } from "node:crypto"
import { PartnerLocalFault } from "./partner-local-boundary"

export interface ServiceModelBinding {
  ref: string
  name: string
  hash: string
}
/** Only these non-secret execution parameters enter the hash. Never serialize
 * registry config wholesale: it contains API keys and may gain secret fields. */
export function serviceModelBinding(
  config: {
    ref: string
    name: string
    apiKey?: string
    baseUrl: string
    model: string
    maxTokens?: number
    maxOutputTokens?: number
    temperature?: number
    topP?: number
    topK?: number
    enableThinking?: boolean
    enableThinkingEffort?: boolean
    interleavedThinking?: boolean
    thinkingEffort?: string
  } | null,
  ref: string
): ServiceModelBinding {
  if (
    !config ||
    config.ref !== ref ||
    !/^(builtin|custom):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(ref) ||
    !config.apiKey?.trim() ||
    !config.model ||
    !config.baseUrl
  )
    throw new PartnerLocalFault("MODEL_UNAVAILABLE")
  let endpoint: URL
  try {
    endpoint = new URL(config.baseUrl)
  } catch {
    throw new PartnerLocalFault("MODEL_UNAVAILABLE")
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new PartnerLocalFault("MODEL_UNAVAILABLE")
  const values = [
    ref,
    config.baseUrl,
    config.model,
    config.maxTokens,
    config.maxOutputTokens,
    config.temperature,
    config.topP,
    config.topK,
    config.enableThinking,
    config.enableThinkingEffort,
    config.interleavedThinking,
    config.thinkingEffort
  ]
  return {
    ref,
    name: config.name,
    hash: createHash("sha256").update(JSON.stringify(values)).digest("hex")
  }
}
export async function resolveServiceModel(ref: string): Promise<ServiceModelBinding> {
  const { getModelConfigByRef } = await import("../../models/registry")
  return serviceModelBinding(getModelConfigByRef(ref), ref)
}

/** Preserve the exact checked configuration across asynchronous engine loading. */
export async function instantiateBoundServiceModel<
  C extends NonNullable<Parameters<typeof serviceModelBinding>[0]>,
  T
>(
  ref: string,
  hash: string,
  config: C | null,
  instantiate: (snapshot: C) => Promise<T>
): Promise<T> {
  if (!config) throw new PartnerLocalFault("MODEL_UNAVAILABLE")
  const snapshot = { ...config }
  if (serviceModelBinding(snapshot, ref).hash !== hash) throw new PartnerLocalFault("MODEL_CHANGED")
  return instantiate(snapshot)
}
