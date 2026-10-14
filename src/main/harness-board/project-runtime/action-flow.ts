import type { HostFlowDefinition } from "../../../shared/mods/flows/types"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { HostProjectState } from "../../../shared/project-runtime/host-types"
import type { CapturedProjectActionInputs } from "./action-input"
import { runtimeDigest } from "./safe-files"

/** Pure translation. Execute through FlowManager.startSaved; this creates no grants or processes. */
export function createProjectActionFlow(
  state: HostProjectState,
  operationId: string,
  captured: CapturedProjectActionInputs
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
  const definition: HostFlowDefinition = {
    schemaVersion: 2,
    execution: { kind: "host" },
    id: `project-actions-${runtimeDigest(operationId).slice(0, 24)}`,
    name: `${state.name} · ${stage.title}`.slice(0, 100),
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
