import { isSameWorkspacePath } from "../../shared/workspace-path"
import type { FlowRun } from "../../shared/mods/flows/types"
import type { HostSkillExecutionContext } from "./project-runtime/host-service"
import type { CapturedProjectActionInputs } from "./project-runtime/action-input"
import {
  captureNativeFlowActionFacts,
  type FlowActionExecutionFacts
} from "../mods/flows/action-execution-facts"
import { getProjectActionRuntime } from "./project-action-runtime"
import { createProjectActionFlow } from "./project-runtime/action-flow"
import { flowDigest } from "../mods/flows/store"

export type ProjectActionPhase = "actions" | "checks" | "context"

/** Uses the application's original Flow, permission, cancellation and uncertainty handling. */
export async function executeProjectActionPhase(
  context: HostSkillExecutionContext,
  threadId: string,
  captured: CapturedProjectActionInputs,
  phase: ProjectActionPhase,
  assertCurrent: () => void,
  assertContentCurrent: () => void = assertCurrent
): Promise<FlowRun | undefined> {
  const runtime = getProjectActionRuntime()
  const workspace = context.project.workspace
  captured.assertCurrent()
  captured.assertScope(context.project)
  assertContentCurrent()
  await runtime.prepareSelection(workspace, threadId, captured.bindings)
  assertCurrent()
  const definition = createProjectActionFlow(
    context.project,
    context.ticket.operationId,
    captured,
    phase
  )
  const saved = { definition, revision: 1, digest: flowDigest(definition), updatedAt: Date.now() }
  if (phase !== "actions") captureNativeFlowActionFacts(saved)
  const run = await runtime.flows.startSaved(
    workspace,
    threadId,
    saved,
    { workspace, goal: context.project.goal },
    assertCurrent
  )
  const cancel = () => {
    void runtime.flows.cancel(workspace, threadId, run.id).catch(() => {})
  }
  context.signal.addEventListener("abort", cancel, { once: true })
  if (context.signal.aborted) cancel()
  try {
    await runtime.flows.waitForSettlement(workspace, threadId, run.id)
    assertContentCurrent()
    return runtime.flows.run(workspace, threadId, run.id) ?? undefined
  } finally {
    context.signal.removeEventListener("abort", cancel)
  }
}

/** A public output rewrite cannot supply original facts or bind a different artifact input. */
export function readProjectActionPhaseFacts(input: {
  project: HostSkillExecutionContext["project"]
  operationId: string
  threadId: string
  captured: CapturedProjectActionInputs
  phase: ProjectActionPhase
  /** Historical composition proof may retain only checks that own final artifact bytes. */
  originalCheckActionIds?: readonly string[]
}): Map<string, FlowActionExecutionFacts> {
  const runtime = getProjectActionRuntime()
  if (!runtime.readRuns || !runtime.readActionResult)
    throw Error("PROJECT_ACTION_NATIVE_FACTS_UNAVAILABLE")
  const { project, threadId, captured } = input
  const expected = createProjectActionFlow(project, input.operationId, captured, input.phase)
  const runs = runtime
    .readRuns(project.workspace, threadId)
    .filter((run) => run.flow.definition.id === expected.id)
  if (runs.length !== 1) throw Error("PROJECT_ACTION_NATIVE_FACTS_MISSING")
  const run = runs[0]
  const originalIds = input.originalCheckActionIds
  const actual =
    originalIds && input.phase === "checks"
      ? {
          ...run.flow.definition,
          maxExecutions: captured.bindings.length + 2,
          steps: run.flow.definition.steps.filter((step) =>
            captured.bindings.some((binding) => binding.id === step.id)
          )
        }
      : run.flow.definition
  if (
    run.threadId !== threadId ||
    !isSameWorkspacePath(run.workspace, project.workspace) ||
    run.status !== "complete" ||
    flowDigest(actual) !== flowDigest(expected) ||
    flowDigest(run.flow.definition) !== run.flow.digest ||
    (originalIds &&
      (run.flow.definition.maxExecutions !== originalIds.length + 2 ||
        JSON.stringify(run.flow.definition.steps.map((step) => step.id)) !==
          JSON.stringify(originalIds)))
  )
    throw Error("PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED")
  const result = new Map<string, FlowActionExecutionFacts>()
  for (const binding of captured.bindings) {
    const attempts = run.attempts.filter((item) => item.stepId === binding.id)
    const attempt = attempts.at(-1)
    if (
      !attempt ||
      attempt.status !== "passed" ||
      attempt.invalidated ||
      Object.hasOwn(attempt, "reusedFrom")
    )
      throw Error("PROJECT_ACTION_NATIVE_FACTS_UNSETTLED")
    const fact = runtime.readActionResult(project.workspace, threadId, run.id, attempt.executionId)
    if (
      !fact ||
      fact.definitionDigest !== run.flow.digest ||
      fact.executionId !== attempt.executionId ||
      fact.runId !== run.id ||
      fact.stepId !== binding.id ||
      fact.threadId !== threadId ||
      !isSameWorkspacePath(fact.workspace, project.workspace) ||
      fact.provider.pluginId !== binding.ref.pluginId ||
      fact.provider.plugin !== binding.ref.plugin ||
      fact.provider.digest !== binding.ref.digest ||
      fact.provider.actionId !== binding.ref.actionId
    )
      throw Error("PROJECT_ACTION_NATIVE_FACTS_SCOPE_CHANGED")
    result.set(binding.id, fact)
  }
  captured.assertCurrent()
  return result
}
