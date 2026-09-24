import type { ModsManager } from "../manager"
import { ModError } from "../errors"

/** Preserve the captured runtime scope across asynchronous mandatory output filtering. */
export async function queryFunctionAgentList(
  manager: ModsManager,
  workspace: string,
  threadId: string,
  signal: AbortSignal,
  assertThread: (bound: boolean) => void
) {
  const scope = manager.functionRuntimeScope(workspace, threadId)
  const check = () => {
    signal.throwIfAborted()
    scope.assertLive()
    if (!manager.isEnabled(workspace)) throw new ModError("MODS_DISABLED")
    assertThread(scope.bound)
  }
  check()
  const rows = manager.listFunctionAgents(workspace, threadId, signal)
  const result = await manager.publish(workspace, rows, undefined, signal)
  check()
  return result
}
