import { getThreadCore } from "../../db"
import type { ModsManager } from "../manager"
import { ModError } from "../errors"

/** Cold metadata is available only for an ordinary foreground thread; other roles own a runtime. */
export async function queryFunctionToolCatalog(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  workspace: string,
  threadId: string,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const scope = manager.captureFunctionToolCatalog(workspace, threadId)
  try {
    if (scope.tools) return scope.tools
    assertPlainThread(threadId)
    const initial = getThreadCore(threadId)?.metadata
    if (!initial) throw new ModError("MODS_THREAD_MISSING")
    const metadata = typeof initial === "string" ? JSON.parse(initial) : initial
    if (
      metadata.targetKind === "inbox" ||
      metadata.targetKind === "feature" ||
      metadata.isHeartbeat === true ||
      typeof metadata.scheduledTaskId === "string"
    )
      throw new ModError("MODS_TOOL_CONTEXT_REQUIRED")
    const { prepareForegroundRuntimeToolCatalog } = await import("../../agent/runtime")
    scope.assertLive()
    const result = await prepareForegroundRuntimeToolCatalog(workspace, threadId, metadata, signal)
    signal.throwIfAborted()
    scope.assertLive()
    assertPlainThread(threadId)
    if (getThreadCore(threadId)?.metadata !== initial) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    return result
  } finally {
    scope.release()
  }
}
