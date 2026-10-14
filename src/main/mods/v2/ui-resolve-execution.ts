import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { currentFunctionExecution } from "./execution-context"
import { functionCallAgent, functionCallAuthority, functionCallTurn } from "./host-call"
import type { ModRuntimeAuthority } from "../runtime-instance"

export interface FunctionUiResolveExecution {
  readonly workspace: string
  readonly threadId: string
  readonly agentId: string
  readonly turnId: string | undefined
  readonly runtimeAuthority: ModRuntimeAuthority | undefined
  assertCurrent(): void
}

/** Keep real actor/turn facts; do not retain an ended entry or mint a human write lease. */
export function captureFunctionUiResolveExecution(
  workspace: string,
  threadId: string
): FunctionUiResolveExecution {
  const current = currentFunctionExecution()
  if (!current || current.workspace !== workspace || current.threadId !== threadId)
    throw new ModFunctionError("MODS_UI_RESOLVE_EXECUTION_REQUIRED")
  const agentId = functionCallAgent(workspace, threadId)
  const turnId = functionCallTurn(workspace, threadId)
  const runtimeAuthority = functionCallAuthority(workspace, threadId)
  return Object.freeze({
    workspace,
    threadId,
    agentId,
    turnId,
    runtimeAuthority,
    assertCurrent() {
      runtimeAuthority?.assertLive()
    }
  })
}
