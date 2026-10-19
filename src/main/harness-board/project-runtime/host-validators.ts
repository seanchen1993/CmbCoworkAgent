import type { HostActionCheckEvidence } from "./action-check-evidence"
import type { ModObject } from "../../../shared/mods/types"
import { clawActionObject } from "../../../shared/mods/claw-actions"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import type {
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState,
  HostValidationReceipt
} from "../../../shared/project-runtime/host-types"
import { validateRegisteredToolInput, validateToolSchema } from "../../mods/v2/tool-schema"
import { hostStateError } from "./host-state-protocol"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectoryIdentity } from "./safe-files"

/** This adapter has no implicit shell/custom-action validator fallback. */
export function assertHostRuntimeSupported(manifest: ProjectRuntimeManifest): void {
  if (manifest.mode !== "host" || manifest.stateOwner !== "host") hostStateError("OWNER_MISMATCH")
  for (const check of manifest.checks) {
    if (check.kind === "json-schema")
      validateToolSchema(clawActionObject(check.schema), { allowReservedKeys: true })
  }
  for (const stage of manifest.stages) {
    if (!stage.skill) hostStateError("SKILL_REQUIRED")
  }
}

function stageFor(state: HostProjectState, operation: HostExecutionTicket | HostProjectOperation) {
  if (
    state.projectId !== operation.projectId ||
    state.version !== operation.expectedVersion ||
    state.pluginDigest !== operation.pluginDigest ||
    state.manifest.stages[state.stageIndex]?.id !== operation.stageId
  )
    hostStateError("VERSION_CONFLICT")
  return state.manifest.stages[state.stageIndex]
}

/** Checked current outputs may be revised; other preceding artifacts remain immutable inputs. */
export function fingerprintHostStageInput(
  state: HostProjectState,
  goal: string,
  runtimeInputIdentity?: string
): string {
  const stage = state.manifest.stages[state.stageIndex]
  const outputPaths = new Set(
    state.manifest.checks
      .filter(
        (check) =>
          stage?.checkIds.includes(check.id) && stage.artifactIds.includes(check.artifactId)
      )
      .map(
        (check) =>
          state.manifest.artifacts.find((artifact) => artifact.id === check.artifactId)!.path
      )
  )
  const paths = new Set(
    state.manifest.stages
      .slice(0, state.stageIndex)
      .flatMap((stage) => stage.artifactIds)
      .map((id) => state.manifest.artifacts.find((artifact) => artifact.id === id)!.path)
  )
  let totalBytes = 0
  const files = [...paths].sort().map((path) => {
    const file = readRuntimeScopedFile(state.workspace, path)
    if (
      !file.present &&
      state.manifest.artifacts.some((item) => item.path === path && item.required)
    )
      hostStateError("REQUIRED_INPUT_MISSING")
    totalBytes += file.bytes?.length ?? 0
    if (totalBytes > 16 * 1024 * 1024) hostStateError("VALIDATION_LIMIT")
    return { path: file.path, fingerprint: file.fingerprint }
  })
  return runtimeDigest(
    JSON.stringify({
      goal,
      projectId: state.projectId,
      workspace: runtimeDirectoryIdentity(state.workspace),
      version: state.version,
      stage: state.manifest.stages[state.stageIndex]?.id,
      pluginDigest: state.pluginDigest,
      ...(runtimeInputIdentity === undefined ? {} : { runtimeInputIdentity }),
      // Still read all preceding files above: required inputs cannot disappear, unsafe paths
      // and byte limits still fail. Revised outputs receive new stage receipts; old receipts
      // remain historical and cannot validate the new bytes or capture them as old knowledge.
      files: files
        .filter((file) => !outputPaths.has(file.path))
        .map((file) => [file.path, file.fingerprint])
    })
  )
}

/** Host-issued receipts reflect file bytes read now, never a model's statement of completion. */
export function validateHostStage(
  state: HostProjectState,
  ticket: HostExecutionTicket,
  signal?: AbortSignal,
  now = () => Date.now(),
  actionChecks: ReadonlyMap<string, HostActionCheckEvidence> = new Map(),
  runtimeInputIdentity?: string
): HostValidationReceipt[] {
  assertHostRuntimeSupported(state.manifest)
  const stage = stageFor(state, ticket)
  let totalBytes = 0
  return stage.checkIds.map((checkId) => {
    signal?.throwIfAborted()
    const check = state.manifest.checks.find((check) => check.id === checkId)!
    const artifact = state.manifest.artifacts.find((artifact) => artifact.id === check.artifactId)!
    const file = readRuntimeScopedFile(state.workspace, artifact.path)
    totalBytes += file.bytes?.length ?? 0
    if (totalBytes > 16 * 1024 * 1024) hostStateError("VALIDATION_LIMIT")
    let result: HostValidationReceipt["result"] = file.present ? "passed" : "failed"
    if (file.present && check.kind === "json-schema") {
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
        )
        // Tool schema's bounded data profile accepts an object root; it never resolves remote refs.
        validateRegisteredToolInput(
          clawActionObject(check.schema),
          clawActionObject(value) as ModObject
        )
      } catch {
        result = "failed"
      }
    }
    const action = check.kind === "action" ? actionChecks.get(check.id) : undefined
    if (check.kind === "action") result = file.present ? (action?.result ?? "unknown") : "failed"
    signal?.throwIfAborted()
    return {
      schemaVersion: 1,
      operationId: ticket.operationId,
      projectId: ticket.projectId,
      stageId: ticket.stageId,
      pluginDigest: ticket.pluginDigest,
      inputFingerprint: ticket.inputFingerprint,
      artifactFingerprint: file.fingerprint,
      checkId,
      result,
      validatorVersion: hostValidatorIdentity(
        action?.validatorVersion ?? `host-${check.kind}/v1`,
        runtimeInputIdentity
      ),
      checkedAt: now()
    }
  })
}

/** Call without an await before the store's synchronous transition transaction. */
export function assertHostReceiptsCurrent(
  state: HostProjectState,
  operation: HostProjectOperation,
  actionChecks: ReadonlyMap<string, HostActionCheckEvidence> = new Map(),
  runtimeInputIdentity?: string
): void {
  const stage = stageFor(state, operation)
  let totalBytes = 0
  for (const checkId of stage.checkIds) {
    const check = state.manifest.checks.find((check) => check.id === checkId)!
    const artifact = state.manifest.artifacts.find((artifact) => artifact.id === check.artifactId)!
    const receipt = operation.receipts.find((receipt) => receipt.checkId === checkId)
    const file = readRuntimeScopedFile(state.workspace, artifact.path)
    totalBytes += file.bytes?.length ?? 0
    if (totalBytes > 16 * 1024 * 1024) hostStateError("VALIDATION_LIMIT")
    const action = check.kind === "action" ? actionChecks.get(check.id) : undefined
    const validator = hostValidatorIdentity(
      action?.validatorVersion ?? `host-${check.kind}/v1`,
      runtimeInputIdentity
    )
    if (
      !receipt ||
      receipt.result !== "passed" ||
      receipt.artifactFingerprint !== file.fingerprint ||
      receipt.validatorVersion !== validator ||
      (check.kind === "action" && action?.result !== "passed")
    )
      hostStateError("EVIDENCE_STALE")
  }
}

function hostValidatorIdentity(base: string, runtimeInputIdentity?: string): string {
  return runtimeInputIdentity === undefined
    ? base
    : `${base}:inputs-${runtimeDigest(runtimeInputIdentity)}`
}
