import type {
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState,
  HostValidationReceipt
} from "../../../shared/project-runtime/host-types"
import { captureProjectActionInputs, readProjectActionLock } from "./action-input"
import { readProjectActionPhaseFacts, readFailedProjectCheckDiagnostics } from "../project-action-phase"
import { runtimeDigest } from "./safe-files"
import { PROJECT_ARTIFACT_REFERENCE_FORMAT } from "../../../shared/project-runtime/artifact-reference"

export type HostActionCheckEvidence = Pick<HostValidationReceipt, "result" | "validatorVersion">

/** Compatibility projection for old failed operations. Never mutates history or reruns a check. */
export function readHistoricalHostCheckDiagnostics(
  project: HostProjectState, operation: HostProjectOperation, snapshotRoot: string
) {
  if (operation.status !== "failed" || !operation.execution ||
    operation.execution.terminal?.outcome !== "error" ||
    !["project_checks_failed", "import_validation_check_failed"].includes(operation.execution.terminal.code) ||
    operation.projectId !== project.projectId || operation.pluginDigest !== project.pluginDigest ||
    operation.expectedVersion !== project.version ||
    operation.stageId !== project.manifest.stages[project.stageIndex]?.id) return []
  const checks = project.manifest.checks.filter(check => check.kind === "action" &&
    project.manifest.stages[project.stageIndex].checkIds.includes(check.id))
  if (!checks.length) return []
  const lock = readProjectActionLock(snapshotRoot, project.manifest)
  const captured = captureProjectActionInputs(project, lock, {
    actionIds: checks.map(check => check.actionId!), allowCheckArtifacts: true
  })
  return readFailedProjectCheckDiagnostics({ project, ticket: {
    operationId: operation.operationId, projectId: project.projectId,
    stageId: operation.stageId, expectedVersion: operation.expectedVersion,
    inputFingerprint: operation.inputFingerprint, pluginDigest: operation.pluginDigest
  } }, operation.execution.threadId, captured)
}
// A JSON field or forged public Flow result cannot opt a schema check into a larger data profile.
const referenceBudgets = new WeakMap<
  object,
  {
    budgets: ReadonlyMap<string, number>
    assertCurrent(): void
  }
>()
export function hostArtifactReferenceBudget(
  evidence: ReadonlyMap<string, HostActionCheckEvidence>,
  artifactId: string
): number | undefined {
  const retained = referenceBudgets.get(evidence)
  const budget = retained?.budgets.get(artifactId)
  if (budget !== undefined) retained!.assertCurrent()
  return budget
}

/** Pure inspection of the existing persisted original Flow attempts; never replays a check. */
export function readHostActionCheckEvidence(
  project: HostProjectState,
  ticket: HostExecutionTicket,
  operation: HostProjectOperation,
  snapshotRoot: string,
  onlyCheckIds?: readonly string[]
): ReadonlyMap<string, HostActionCheckEvidence> {
  const stage = project.manifest.stages[project.stageIndex]
  const allChecks = project.manifest.checks.filter(
    (item) => stage.checkIds.includes(item.id) && item.kind === "action"
  )
  const checks = allChecks.filter((check) => !onlyCheckIds || onlyCheckIds.includes(check.id))
  if (!checks.length) return new Map()
  const threadId = operation.execution?.threadId
  if (
    !threadId ||
    operation.operationId !== ticket.operationId ||
    operation.projectId !== ticket.projectId
  )
    throw Error("PROJECT_ACTION_CHECK_EXECUTION_REQUIRED")
  const lock = readProjectActionLock(snapshotRoot, project.manifest)
  const captured = captureProjectActionInputs(project, lock, {
    actionIds: checks.map((item) => item.actionId!),
    allowCheckArtifacts: true
  })
  const facts = readProjectActionPhaseFacts({
    project,
    operationId: ticket.operationId,
    threadId,
    captured,
    phase: "checks",
    ...(onlyCheckIds ? { originalCheckActionIds: allChecks.map((check) => check.actionId!) } : {})
  })
  const result = new Map<string, HostActionCheckEvidence>(
    checks.map((check) => {
      const fact = facts.get(check.actionId!)
      if (!fact) throw Error("PROJECT_ACTION_NATIVE_FACTS_MISSING")
      return [
        check.id,
        {
          result: fact.passed ? "passed" : "failed",
          validatorVersion: `host-action/v1:${runtimeDigest(
            JSON.stringify({
              input: captured.bindings.find((binding) => binding.id === check.actionId),
              runId: fact.runId,
              executionId: fact.executionId,
              source: fact.provider,
              result: fact.resultDigest
            })
          )}`
        }
      ]
    })
  )
  const budgets = new Map<string, number>()
  for (const check of checks) {
    const from = lock.bindings.find((binding) => binding.id === check.actionId)?.inputFrom
    if (
      result.get(check.id)?.result === "passed" &&
      from?.kind === "artifact" &&
      from.format === PROJECT_ARTIFACT_REFERENCE_FORMAT
    ) {
      budgets.set(
        check.artifactId,
        Math.min(budgets.get(check.artifactId) ?? from.maxBytes, from.maxBytes)
      )
    }
  }
  referenceBudgets.set(result, { budgets, assertCurrent: captured.assertCurrent })
  return result
}
