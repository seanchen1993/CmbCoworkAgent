import type { ModObject } from "../../../shared/mods/types"
import type { CompletionPolicy } from "../../../shared/mods/v2/completion-policy-values"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { autobizFeatureEvidencePaths } from "../adapters/autobiz-completion-evidence"

export interface CompletionBusinessEntry {
  readonly plugin: string
  readonly active: boolean
  readonly policy: CompletionPolicy | undefined
  readonly application: ModObject | undefined
}

interface CompletionBusinessStage {
  readonly plugin: string
  readonly feature: string
  readonly start: string
}

export interface RequestedCompletionStage {
  readonly feature: string
  readonly start: string
}

function applicationStage(
  plugin: string,
  application: ModObject | undefined
): CompletionBusinessStage | undefined {
  return application &&
    typeof application.autobizStartCheckpoint === "string" &&
    typeof application.feature === "string"
    ? Object.freeze({
        plugin,
        feature: application.feature,
        start: application.autobizStartCheckpoint
      })
    : undefined
}

/** Application evidence selection is data only; it grants no access to the selected paths. */
export function planCompletionApplicationEvidence(
  entries: readonly Pick<CompletionBusinessEntry, "plugin" | "application">[]
) {
  const stages = entries.flatMap(({ plugin, application }) => {
    const stage = application?.mode !== "off" ? applicationStage(plugin, application) : undefined
    return stage ? [stage] : []
  })
  return Object.freeze({
    stages: Object.freeze(stages),
    evidenceReferences:
      stages.length > 0 ||
      entries.some(
        ({ application }) =>
          application &&
          application.mode !== "off" &&
          Array.isArray(application.checks) &&
          application.checks.includes("autobiz-validator")
      )
  })
}

/** Fixed host business selection. Manager retains every grant, source and effect boundary. */
export function planCompletionBusiness(
  entries: readonly CompletionBusinessEntry[],
  requestedStage?: RequestedCompletionStage
) {
  const active = entries.filter((entry) => entry.active)
  const stages = active.flatMap(({ plugin, application }) => {
    const stage = applicationStage(plugin, application)
    return stage ? [stage] : []
  })
  if (
    new Set(stages.map((stage) => JSON.stringify([stage.feature, stage.start]))).size > 1 ||
    (requestedStage &&
      stages.some(
        (stage) => stage.feature !== requestedStage.feature || stage.start !== requestedStage.start
      ))
  )
    throw new ModFunctionError("MODS_AUTOBIZ_STAGE_CONFLICT")
  const automaticStage = requestedStage ? Object.freeze({ ...requestedStage }) : stages[0]
  const validatorFeatures = [
    ...new Set(
      active
        .filter(({ policy }) => policy?.checks.includes("autobiz-validator"))
        .map(({ policy }) => policy!.feature)
    )
  ]
  return Object.freeze({
    automaticStage,
    validatorFeatures: Object.freeze(validatorFeatures),
    evidenceReferences: validatorFeatures.length > 0 || Boolean(automaticStage)
  })
}

/** Keep path validation at the original evidence-capture boundary, never gate creation. */
export function completionBusinessEvidencePaths(
  entries: readonly Pick<CompletionBusinessEntry, "policy">[]
): readonly string[] {
  return Object.freeze(
    entries.flatMap(({ policy }) => {
      if (!policy || policy.mode === "off") return []
      if (policy.scope === "file") return policy.target ? [policy.target] : []
      if (policy.scope === "feature")
        return [
          ...(policy.feature ? autobizFeatureEvidencePaths(policy.feature) : []),
          ...(policy.target ? [policy.target] : [])
        ]
      return policy.scope === "project" ? ["."] : []
    })
  )
}
