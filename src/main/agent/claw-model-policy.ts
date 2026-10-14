import type { ClawProfile } from "../../shared/mods/claw"
import type { ResolvedModelConfig } from "../models/registry"
import { clawModelFingerprint } from "../mods/flows/model-fingerprint"

/** Limits per-call Mod routing to this Claw's configured providers, retaining host credentials. */
export function createClawModelGuard(
  profile: ClawProfile | null,
  current: ResolvedModelConfig,
  lookup: (ref: string) => ResolvedModelConfig | null
): ((model: object) => void) | undefined {
  if (!profile?.models) return undefined
  const refs = new Set(
    [
      current.ref,
      profile.models.default,
      ...Object.values(profile.models.roles),
      ...(profile.flow?.definition.steps.flatMap((step) =>
        step.enabled && step.kind === "agent" ? [step.modelId] : []
      ) ?? [])
    ].filter((ref): ref is string => typeof ref === "string")
  )
  const fingerprints = new Map<string, string>()
  for (const ref of refs) {
    const model = lookup(ref)
    if (!model?.apiKey) throw Error(`CLAW_MODEL_UNAVAILABLE: ${ref}`)
    fingerprints.set(model.ref, clawModelFingerprint(model))
  }
  return (model) => {
    const ref = "ref" in model && typeof model.ref === "string" ? model.ref : ""
    if (!fingerprints.has(ref)) throw Error("CLAW_MODEL_NOT_ALLOWED")
    for (const [id, fingerprint] of fingerprints) {
      const live = lookup(id)
      if (!live?.apiKey || clawModelFingerprint(live) !== fingerprint)
        throw Error("CLAW_MODEL_CONFIGURATION_CHANGED")
    }
    if (clawModelFingerprint(model as ResolvedModelConfig) !== fingerprints.get(ref))
      throw Error("CLAW_MODEL_CONFIGURATION_CHANGED")
  }
}
