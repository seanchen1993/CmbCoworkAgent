import type {
  HostExecutionTicket,
  HostProjectOperation,
  HostProjectState,
  HostValidationReceipt
} from "../../../shared/project-runtime/host-types"
import { captureProjectActionInputs, readProjectActionLock } from "./action-input"
import { readProjectActionPhaseFacts } from "../project-action-phase"
import { runtimeDigest } from "./safe-files"

export type HostActionCheckEvidence = Pick<HostValidationReceipt, "result" | "validatorVersion">

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
  const captured = captureProjectActionInputs(
    project,
    readProjectActionLock(snapshotRoot, project.manifest),
    {
      actionIds: checks.map((item) => item.actionId!),
      allowCheckArtifacts: true
    }
  )
  const facts = readProjectActionPhaseFacts({
    project,
    operationId: ticket.operationId,
    threadId,
    captured,
    phase: "checks",
    ...(onlyCheckIds ? { originalCheckActionIds: allChecks.map((check) => check.actionId!) } : {})
  })
  return new Map(
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
}
