import type { ModCommandQueue } from "../command-queue"
import type { ModsManager } from "../manager"
import { withFreshFunctionExecution } from "./execution-context"

/** Explicit desktop actions use the existing physical run queue and job ledger. */
export async function runPlatformUserAction<T>(
  queue: ModCommandQueue,
  manager: Pick<ModsManager, "functionUserScope">,
  workspace: string,
  threadId: string,
  signal: AbortSignal,
  assertCurrent: () => void,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  assertCurrent()
  let result!: T
  await queue.enqueue(
    workspace,
    threadId,
    "platform-ui-action",
    async (jobSignal) => {
      const operationSignal = AbortSignal.any([signal, jobSignal])
      operationSignal.throwIfAborted()
      assertCurrent()
      result = await withFreshFunctionExecution(
        {
          ...manager.functionUserScope(workspace, threadId),
          workspace,
          threadId,
          leased: true,
          immediate: false,
          userInitiated: true
        },
        async () => {
          const answer = await work(operationSignal)
          operationSignal.throwIfAborted()
          assertCurrent()
          return answer
        }
      )
      // Rich results and capability state stay in their own bounded native registries.
      return { text: "" }
    },
    { signal, inlineResult: true }
  ).completion
  return result
}
