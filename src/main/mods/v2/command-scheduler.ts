import type { ModObject } from "../../../shared/mods/types"
import { AsyncResource } from "node:async_hooks"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import type { ModCommandQueue } from "../command-queue"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  functionExecutionScope,
  isFunctionUserAction,
  withFunctionExecution
} from "./execution-context"

/** Keep the SDK result intact while the existing job ledger stores its text projection. */
export async function scheduleFunctionCommand(
  queue: ModCommandQueue,
  workspace: string,
  threadId: string,
  command: FunctionCommand,
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<ModObject>
): Promise<ModObject> {
  let answer!: ModObject
  const scope = functionExecutionScope(workspace, threadId)
  const userInitiated = isFunctionUserAction(workspace, threadId)
  await queue.enqueue(
    workspace,
    threadId,
    command.name,
    AsyncResource.bind(async (jobSignal: AbortSignal) => {
      if (scope && !scope.active) throw new ModFunctionError("MODS_CALL_SCOPE_EXPIRED")
      answer = await withFunctionExecution(
        {
          workspace,
          threadId,
          agentId: scope?.agentId,
          turnId: scope?.turnId,
          runtimeAuthority: scope?.runtimeAuthority,
          leased: !command.immediate,
          immediate: command.immediate === true,
          userInitiated
        },
        () => run(jobSignal)
      )
      return { text: typeof answer.text === "string" ? answer.text : "" }
    }),
    { immediate: command.immediate === true, signal }
  ).completion
  return answer
}
