import type { ModObject } from "../../../shared/mods/types"
import type { FunctionCommand } from "../../../shared/mods/v2/commands"
import type { ModCommandQueue } from "../command-queue"

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
  await queue.enqueue(
    workspace,
    threadId,
    command.name,
    async (jobSignal) => {
      answer = await run(jobSignal)
      return { text: typeof answer.text === "string" ? answer.text : "" }
    },
    { immediate: command.immediate === true, signal }
  ).completion
  return answer
}
