import {
  clawActionObject,
  resolveClawActionInput,
  type ClawActionDescriptor
} from "../../../shared/mods/claw-actions"
import { encodeModJson } from "../../../shared/mods/validation"
import {
  PROJECT_ACTION_LOCK_MAX_BYTES,
  PROJECT_ACTION_LOCK_PATH,
  parseProjectActionLock,
  projectActionTarget,
  type ProjectActionBinding,
  type ProjectActionLock
} from "../../../shared/project-runtime/action-bindings"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import { validateRegisteredToolInput, validateToolSchema } from "../../mods/v2/tool-schema"
import { validateClawActionConfig } from "../../mods/v2/action-config"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectoryIdentity } from "./safe-files"

function stable(value: unknown): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, sort(entry)])
          )
        : value
  return encodeModJson(sort(value))
}
/** Display/review identity for the action contract, independent of JSON property ordering. */
export function projectActionContractDigest(
  action: Pick<
    ClawActionDescriptor,
    "command" | "platform" | "inputSchema" | "configSchema" | "outputSchema"
  >
): string {
  return runtimeDigest(
    stable({
      ...projectActionTarget(action),
      inputSchema: action.inputSchema,
      configSchema: action.configSchema ?? null,
      outputSchema: action.outputSchema ?? null
    })
  )
}
export function createProjectActionBinding(
  id: string,
  action: ClawActionDescriptor,
  input: ProjectActionBinding["input"],
  config: ProjectActionBinding["config"] = {},
  inputFrom?: ProjectActionBinding["inputFrom"]
): ProjectActionBinding {
  const binding = parseProjectActionLock({
    apiVersion: "devclaw.project-actions-lock/v1",
    bindings: [
      {
        id,
        ref: {
          pluginId: action.pluginId,
          plugin: action.plugin,
          digest: action.digest,
          actionId: action.actionId
        },
        ...projectActionTarget(action),
        input,
        config,
        ...(inputFrom ? { inputFrom } : {}),
        inputSchema: action.inputSchema,
        configSchema: action.configSchema ?? null,
        outputSchema: action.outputSchema ?? null
      }
    ]
  }).bindings[0]
  validateBinding(binding)
  return binding
}
function validateBinding(binding: ProjectActionBinding) {
  validateToolSchema(binding.inputSchema)
  if (binding.outputSchema) validateToolSchema(binding.outputSchema)
  if (binding.configSchema) validateToolSchema(binding.configSchema)
  validateClawActionConfig(binding.config, binding.configSchema ?? undefined)
  if (!binding.inputFrom) validateRegisteredToolInput(binding.inputSchema, binding.input)
}
/** Selection must be from actionCatalog, which only exposes enabled, approved provider snapshots. */
export function assertProjectActionProviders(
  lock: ProjectActionLock,
  catalog: readonly ClawActionDescriptor[]
): void {
  for (const binding of parseProjectActionLock(lock).bindings) {
    const descriptor = catalog.find(
      (action) =>
        stable({
          pluginId: action.pluginId,
          plugin: action.plugin,
          digest: action.digest,
          actionId: action.actionId
        }) === stable(binding.ref)
    )
    if (
      !descriptor ||
      stable(projectActionTarget(descriptor)) !== stable(projectActionTarget(binding)) ||
      stable(descriptor.inputSchema) !== stable(binding.inputSchema) ||
      stable(descriptor.configSchema ?? null) !== stable(binding.configSchema) ||
      stable(descriptor.outputSchema ?? null) !== stable(binding.outputSchema)
    )
      throw Error("PROJECT_ACTION_PROVIDER_CHANGED")
    validateBinding(binding)
  }
}
export function readProjectActionLock(
  snapshotRoot: string,
  manifest: ProjectRuntimeManifest,
  readFile: (path: string, limit: number) => { bytes?: Buffer } =
    (path, limit) => readRuntimeScopedFile(snapshotRoot, path, limit)
): ProjectActionLock {
  const file = readFile(
    PROJECT_ACTION_LOCK_PATH,
    PROJECT_ACTION_LOCK_MAX_BYTES
  )
  if (!file.bytes) {
    if (manifest.actions.length) throw Error("PROJECT_ACTION_LOCK_MISSING")
    return { apiVersion: "devclaw.project-actions-lock/v1", bindings: [] }
  }
  return assertProjectActionLock(
    manifest,
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  )
}
export function assertProjectActionLock(
  manifest: ProjectRuntimeManifest,
  value: unknown
): ProjectActionLock {
  const lock = parseProjectActionLock(value)
  if (
    manifest.actions.length !== lock.bindings.length ||
    manifest.actions.some(
      (action) =>
        !lock.bindings.some(
          (binding) => binding.id === action.id && stable(binding.ref) === stable(action.ref)
        )
    )
  )
    throw Error("PROJECT_ACTION_LOCK_MISMATCH")
  lock.bindings.forEach(validateBinding)
  for (const [index, stage] of manifest.stages.entries()) {
    const priorArtifacts = new Set(
      manifest.stages.slice(0, index).flatMap((item) => item.artifactIds)
    )
    const seen = new Set<string>()
    for (const id of stage.actionIds) {
      const binding = lock.bindings.find((item) => item.id === id)
      if (!binding) throw Error("PROJECT_ACTION_LOCK_MISMATCH")
      const from = binding.inputFrom
      if (from?.kind === "artifact" && !priorArtifacts.has(from.artifactId))
        throw Error("PROJECT_ACTION_INPUT_NOT_PRIOR")
      if (
        from?.kind === "action" &&
        (!seen.has(from.actionId) ||
          !lock.bindings.find((item) => item.id === from.actionId)?.outputSchema)
      )
        throw Error("PROJECT_ACTION_OUTPUT_ORDER")
      seen.add(id)
    }
    const checkActions = new Set<string>()
    for (const check of manifest.checks.filter(
      (item) => stage.checkIds.includes(item.id) && item.kind === "action"
    )) {
      const binding = lock.bindings.find((item) => item.id === check.actionId)
      if (
        !binding ||
        seen.has(binding.id) ||
        checkActions.has(binding.id) ||
        binding.inputFrom?.kind !== "artifact" ||
        binding.inputFrom.artifactId !== check.artifactId ||
        binding.inputFrom.pointer !== ""
      )
        throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
      checkActions.add(binding.id)
    }
  }
  return lock
}
export interface CapturedProjectActionInputs {
  stageId: string
  bindings: ProjectActionBinding[]
  fingerprint: string
  assertScope(state: HostProjectState): void
  /** Re-read the exact approved artifact inputs before starting an external action. */
  assertCurrent(): void
}
/** Bounded JSON objects only; no path expressions, arbitrary files, credentials or code evaluation. */
export function captureProjectActionInputs(
  state: HostProjectState,
  rawLock: ProjectActionLock,
  phase?: { actionIds: readonly string[]; allowCheckArtifacts?: boolean }
): CapturedProjectActionInputs {
  const project = structuredClone(state),
    lock = parseProjectActionLock(rawLock)
  const stage = project.manifest.stages[project.stageIndex]
  if (!stage) throw Error("PROJECT_ACTION_STAGE_MISSING")
  const scope = (value: HostProjectState) =>
    stable({
      projectId: value.projectId,
      workspace: runtimeDirectoryIdentity(value.workspace),
      version: value.version,
      pluginDigest: value.pluginDigest,
      stageId: value.manifest.stages[value.stageIndex]?.id,
      manifest: value.manifest,
      goal: value.goal
    })
  const capturedScope = scope(project)
  const predecessors = new Set(
    project.manifest.stages.slice(0, project.stageIndex).flatMap((item) => item.artifactIds)
  )
  const checkArtifacts = new Map(
    project.manifest.checks
      .filter((check) => stage.checkIds.includes(check.id) && check.kind === "action")
      .map((check) => [check.actionId!, check.artifactId])
  )
  const read = () => {
    const files: Array<[string, string]> = []
    const seen = new Set<string>()
    let bytes = 0
    const bindings = (phase?.actionIds ?? stage.actionIds).map((id) => {
      const binding = lock.bindings.find((item) => item.id === id)
      const declaration = project.manifest.actions.find((item) => item.id === id)
      if (!binding || !declaration || stable(binding.ref) !== stable(declaration.ref))
        throw Error("PROJECT_ACTION_LOCK_MISMATCH")
      validateBinding(binding)
      const next = structuredClone(binding)
      const from = binding.inputFrom
      if (from?.kind === "action") {
        if (
          !seen.has(from.actionId) ||
          !lock.bindings.find((item) => item.id === from.actionId)?.outputSchema
        )
          throw Error("PROJECT_ACTION_OUTPUT_ORDER")
      } else if (from?.kind === "artifact") {
        const isCheck = phase?.allowCheckArtifacts && checkArtifacts.get(id) === from.artifactId
        if (!predecessors.has(from.artifactId) && !isCheck)
          throw Error("PROJECT_ACTION_INPUT_NOT_PRIOR")
        if (isCheck && from.pointer !== "") throw Error("PROJECT_ACTION_CHECK_INPUT_INVALID")
        const artifact = project.manifest.artifacts.find((item) => item.id === from.artifactId)
        if (
          !artifact ||
          artifact.path
            .split("/")
            .some(
              (part) =>
                /^(?:\.env.*|\.git|\.git-credentials|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials.*|secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519).*)$/iu.test(
                  part
                ) || /\.(?:pem|key|pfx|p12|kdbx)$/iu.test(part)
            )
        )
          throw Error("PROJECT_ACTION_INPUT_FORBIDDEN")
        const file = readRuntimeScopedFile(project.workspace, artifact.path, 28_000)
        if (!file.bytes) throw Error("PROJECT_ACTION_INPUT_MISSING")
        bytes += file.bytes.length
        if (bytes > 128 * 1024) throw Error("PROJECT_ACTION_INPUT_LIMIT")
        const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
        const object =
          from.format === "text" ? { content: text } : clawActionObject(JSON.parse(text))
        if (
          (isCheck || from.format === "text") &&
          Object.keys(binding.input).some((key) => Object.hasOwn(object, key))
        )
          throw Error("PROJECT_ACTION_ARTIFACT_INPUT_OVERRIDE")
        next.input = resolveClawActionInput(binding.input, object, from.pointer)
        delete next.inputFrom
        validateRegisteredToolInput(binding.inputSchema, next.input)
        files.push([artifact.path, file.fingerprint])
      }
      seen.add(id)
      return next
    })
    const fingerprint = runtimeDigest(
      stable({
        projectId: project.projectId,
        version: project.version,
        workspace: runtimeDirectoryIdentity(project.workspace),
        pluginDigest: project.pluginDigest,
        stage: stage.id,
        goal: project.goal,
        bindings,
        files
      })
    )
    return { bindings, fingerprint }
  }
  const captured = read()
  const capturedBindings = stable(captured.bindings)
  return {
    stageId: stage.id,
    ...captured,
    assertScope: (value) => {
      if (scope(value) !== capturedScope) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
    },
    assertCurrent: () => {
      if (
        stable(captured.bindings) !== capturedBindings ||
        read().fingerprint !== captured.fingerprint
      )
        throw Error("PROJECT_ACTION_INPUT_CHANGED")
    }
  }
}
