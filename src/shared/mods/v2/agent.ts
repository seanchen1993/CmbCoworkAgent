import type { ModObject } from "../types"
import { ModFunctionError, isModObject } from "./contracts"

const MOD_TIERS = new Set(["prepend", "user", "append", "builtin", "core"])

export function validateFunctionAgentOfferInput(value: ModObject): void {
  if (
    typeof value.agent !== "string" ||
    value.agent.length === 0 ||
    value.agent.length > 256 ||
    typeof value.description !== "string" ||
    value.description.length > 4000 ||
    typeof value.source !== "string" ||
    value.source.length === 0 ||
    !isModObject(value.provider) ||
    typeof value.provider.plugin !== "string" ||
    value.provider.plugin.length === 0 ||
    typeof value.provider.tier !== "string" ||
    !MOD_TIERS.has(value.provider.tier)
  )
    throw new ModFunctionError("MODS_AGENT_OFFER_ARGUMENTS")
}

export function validateFunctionAgentOfferResult(value: ModObject): void {
  if (typeof value.isOffered !== "boolean")
    throw new ModFunctionError("MODS_AGENT_OFFER_RESULT")
}

export function assertPinnedAgentOfferProvider(value: ModObject, provider: ModObject): void {
  if (
    !isModObject(value.provider) ||
    value.provider.plugin !== provider.plugin ||
    value.provider.tier !== provider.tier
  )
    throw new ModFunctionError("MODS_AGENT_OFFER_PINNED")
}
