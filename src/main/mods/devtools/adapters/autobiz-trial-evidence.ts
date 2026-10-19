import type { CreatorBusinessTrialRecord } from "../creator-business-trial-record"
import type { CreatorLegacyTrialEvidenceOwner } from "../creator-trial-legacy-evidence"
import type { CompositionInternalProject } from "../../../harness-board/project-runtime/composition-internal-projects"
import {
  readAutobizCompositionContracts,
  transitionAutobizComposition
} from "../../../harness-board/project-runtime/composition-autobiz-bridge"
import { readRuntimeScopedFile } from "../../../harness-board/project-runtime/safe-files"
import { parsePluginHooks } from "../../../storage"

function adapterRecord(
  record: CreatorBusinessTrialRecord,
  runId?: string
): CompositionInternalProject {
  if (!record.plugin || !record.project || !record.workspace || !record.packageDigest)
    throw Error("BUSINESS_TRIAL_PROJECT_REQUIRED")
  return {
    projectId: record.id,
    parentProjectId: record.scope.threadId,
    compositionRunId: record.id,
    unitId: record.featureId,
    featureId: record.featureId,
    goal: record.goal,
    workspace: record.workspace,
    workspaceIdentity: record.workspaceIdentity,
    plugin: record.plugin,
    packageDigest: record.packageDigest,
    project: record.project,
    phase: "running",
    ...(runId ? { engineRunId: runId } : {})
  }
}

/** Opt-in original adapter only. Missing producers remain visible evidence gaps, never PASS. */
export async function readAutobizTrialEvidenceContracts(record: CreatorBusinessTrialRecord) {
  if (
    !record.plugin ||
    !readRuntimeScopedFile(record.plugin.path, "devclaw.stage-checks.json", 1024).bytes
  )
    return undefined
  return readAutobizCompositionContracts(adapterRecord(record))
}

export function autobizTrialEvidenceOwner(
  record: CreatorBusinessTrialRecord,
  runId: string,
  assertCurrent: () => void
): CreatorLegacyTrialEvidenceOwner {
  const adapter = adapterRecord(record, runId)
  return {
    trialId: record.id,
    featureId: record.featureId,
    runId,
    workspace: adapter.workspace,
    packageDigest: adapter.packageDigest,
    assertCurrent,
    assertHook: (hook) => {
      const original = parsePluginHooks(adapter.plugin).find((value) => value.id === hook.id)
      if (
        !original ||
        !original.enabled ||
        (original.type ?? "command") !== "command" ||
        original.command !== hook.command ||
        original.event !== hook.event ||
        original.shell !== hook.shell
      )
        throw Error("STAGE_CHECK_HOOK_UNVERIFIED")
    },
    transition: (input) => transitionAutobizComposition(adapter, input)
  }
}
