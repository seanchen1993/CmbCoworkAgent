import type { BuiltinProjectFacts } from "../../../shared/mods/builtins"
import type { BuiltinChangeReviewEvidence } from "../../../shared/mods/builtin-change-review"
import { resolve } from "node:path"
import { startHostRuntimeTiming } from "../../services/host-runtime-timing"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"

export interface ProjectFactObservation {
  identity: string
  facts: BuiltinProjectFacts
  review?: {
    projectId: string
    pluginDigest: string
    stageId: string
    firstProjectAttempt: boolean
    firstStageAttempt: boolean
    evidence: BuiltinChangeReviewEvidence
  }
}
type Reader = (threadId: string, workspace: string) => ProjectFactObservation | undefined
let reader: Reader | undefined
type BindingReader = (threadId: string, workspace: string, projectId: string) => boolean
let bindingReader: BindingReader | undefined

/** Main-only admission read, separate from the richer diagnostic/UI observation. */
export function registerBuiltinProjectBinding(next: BindingReader) {
  if (bindingReader) throw Error("PROJECT_BINDING_ALREADY_REGISTERED")
  bindingReader = next
  return () => {
    if (bindingReader === next) bindingReader = undefined
  }
}
export function readBuiltinProjectBinding(
  threadId: string,
  workspace: string,
  projectId: unknown
): boolean {
  const finishTiming = startHostRuntimeTiming("hostFacts")
  try {
    return typeof projectId === "string" && bindingReader?.(threadId, workspace, projectId) === true
  } catch {
    return false
  } finally {
    finishTiming()
  }
}
/** Main-only observation provider. It neither creates a runtime nor executes a project. */
export function registerBuiltinProjectFacts(next: Reader) {
  if (reader) throw Error("PROJECT_FACTS_ALREADY_REGISTERED")
  reader = next
  return () => {
    if (reader === next) reader = undefined
  }
}
export function readBuiltinProjectFacts(
  threadId: string,
  workspace: string
): ProjectFactObservation {
  const finishTiming = startHostRuntimeTiming("hostFacts")
  try {
    return (
      reader?.(threadId, workspace) ?? {
        identity: "unavailable",
        facts: { state: "unavailable" }
      }
    )
  } catch {
    // An observational ledger must never prevent ordinary chat from starting.
    return { identity: "unavailable", facts: { state: "unavailable" } }
  } finally {
    finishTiming()
  }
}
export function matchesProjectHostBinding(
  threadId: string,
  workspace: string,
  binding: unknown,
  project: HostProjectState | undefined,
  operation: HostProjectOperation | undefined
): boolean {
  if (!project || !binding || typeof binding !== "object") return false
  const scope = binding as Record<string, unknown>
  const index = project.manifest.stages.findIndex((stage) => stage.id === scope.stageId)
  if (
    (process.platform === "win32"
      ? resolve(project.workspace).toLowerCase() !== resolve(workspace).toLowerCase()
      : project.workspace !== workspace) ||
    project.projectId !== scope.projectId ||
    project.pluginDigest !== scope.pluginDigest ||
    !operation ||
    operation.operationId !== scope.operationId ||
    index < 0 ||
    operation.stageId !== scope.stageId ||
    operation.execution?.threadId !== threadId ||
    operation.pluginDigest !== project.pluginDigest
  )
    return false
  return true
}

export function projectHostFacts(
  threadId: string,
  workspace: string,
  binding: unknown,
  project: HostProjectState | undefined,
  operations: readonly HostProjectOperation[]
): ProjectFactObservation | undefined {
  if (!project || !binding || typeof binding !== "object") return undefined
  const scope = binding as Record<string, unknown>
  const operation = operations.find((item) => item.operationId === scope.operationId)
  if (!operation || !matchesProjectHostBinding(threadId, workspace, binding, project, operation))
    return undefined
  const index = project.manifest.stages.findIndex((stage) => stage.id === scope.stageId)
  const checks = { passed: 0, failed: 0, blocked: 0, unknown: 0 }
  for (const receipt of operation.receipts) checks[receipt.result]++
  const facts: BuiltinProjectFacts = {
    state: "observed",
    stageNumber: index + 1,
    totalStages: project.manifest.stages.length,
    currentStageNumber: Math.min(project.stageIndex + 1, project.manifest.stages.length),
    projectStatus: project.status,
    operationStatus: operation.status,
    approval:
      operation.approval?.decision ??
      (project.manifest.stages[index].approval === "human" ? "pending" : "not-required"),
    checks,
    declaredArtifacts: project.manifest.stages[index].artifactIds.length,
    receiptsMatchCurrentVersion: operation.expectedVersion === project.version,
    recordedAttempts: operations.filter(
      (item) => item.stageId === operation.stageId && item.startedAt !== null
    ).length,
    historyMayBeLimited: operations.length >= 20
  }
  return {
    identity: JSON.stringify([
      project.version,
      operation.operationId,
      operation.updatedAt,
      operation.inputFingerprint,
      operation.pluginDigest,
      operation.receipts,
      facts
    ]),
    facts,
    review: {
      projectId: project.projectId,
      pluginDigest: project.pluginDigest,
      stageId: operation.stageId,
      // A truncated ledger cannot prove that this is the first attempt.
      firstProjectAttempt:
        operations.length < 20 &&
        project.version === 1 &&
        project.stageIndex === 0 &&
        operations.filter((item) => item.startedAt !== null).length === 1,
      firstStageAttempt:
        operations.length < 20 &&
        operations.filter((item) => item.stageId === operation.stageId && item.startedAt !== null)
          .length === 1,
      evidence: {
        projectName: project.name,
        stageTitle: project.manifest.stages[index].title,
        operationId: operation.operationId,
        matchesProjectVersion: operation.expectedVersion === project.version,
        checks: operation.receipts.map(({ checkId, result, checkedAt }) => {
          const definition = project.manifest.checks.find((item) => item.id === checkId)
          const artifact = project.manifest.artifacts.find(
            (item) => item.id === definition?.artifactId
          )
          const purpose =
            definition?.kind === "file-exists"
              ? "确认成果文件存在"
              : definition?.kind === "json-schema"
                ? "检查成果结构"
                : "核对插件执行结果"
          return {
            checkId,
            label: artifact ? `${purpose}（${artifact.path}）` : "成果检查",
            result,
            checkedAt
          }
        })
      }
    }
  }
}
