import type { HostFlowDefinition } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import type { CapturedProjectActionInputs } from "./action-input"
import { runtimeDigest } from "./safe-files"

/** Pure translation. Execute through FlowManager.startSaved; this creates no grants or processes. */
export function createProjectActionFlow(
  state: HostProjectState,
  operationId: string,
  captured: CapturedProjectActionInputs,
  phase: "actions" | "checks" | "context" = "actions"
): HostFlowDefinition {
  const stage = state.manifest.stages[state.stageIndex]
  if (
    !stage ||
    stage.id !== captured.stageId ||
    !captured.bindings.length ||
    !operationId ||
    operationId.length > 256
  )
    throw Error("PROJECT_ACTION_FLOW_INVALID")
  captured.assertCurrent()
  captured.assertScope(state)
  for (const binding of captured.bindings) {
    if (!captured.referenceActionIds?.includes(binding.id)) continue
    // Native Flow uses a UUID run/execution identity. Reserve their full sizes before dispatch.
    const envelope = {
      version: 1,
      input: binding.input,
      config: binding.config,
      task: state.goal,
      runId: "flow_" + "0".repeat(36),
      stepId: binding.id,
      executionId: "0".repeat(36)
    }
    if (Buffer.byteLength(JSON.stringify(envelope)) > 16000)
      throw Error("PROJECT_ARTIFACT_REFERENCE_ENVELOPE_LIMIT")
  }
  const definition: HostFlowDefinition = {
    schemaVersion: 2,
    execution: { kind: "host" },
    id: projectActionPhaseId(operationId, phase),
    name: `${state.name} 路 ${stage.title}`.slice(0, 100),
    goal: state.goal,
    timeoutMs: 300_000,
    // Native Flow records final verification and optional mandatory-rule evidence as executions.
    maxExecutions: captured.bindings.length + 2,
    steps: captured.bindings.map((binding) => ({
      id: binding.id,
      name: binding.id,
      enabled: true,
      kind: "plugin-action",
      ...binding.ref,
      input: binding.input,
      config: binding.config,
      ...(binding.inputFrom?.kind === "action"
        ? {
            inputFrom: { stepId: binding.inputFrom.actionId, path: binding.inputFrom.pointer }
          }
        : {})
    }))
  }
  return parseFlowDefinition(definition) as HostFlowDefinition
}

/** Phase identity keeps context/check evidence separate from displayable stage action results. */
export function projectActionPhaseId(operationId: string, phase: "actions" | "checks" | "context") {
  return `project-${phase}-${runtimeDigest(operationId).slice(0, 24)}`
}
