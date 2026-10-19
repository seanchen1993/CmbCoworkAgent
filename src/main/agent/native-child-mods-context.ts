import { readCoordinatorWorkerModsContext } from "./coordinator-worker-mods-context"
import { readWorkflowChildModsContext } from "./workflow-child-mods-context"
import { getThreadCore } from "../db"

/** Only the two original host producers can supply a live read-only parent association. */
export function readNativeChildModsContext(threadId: string) {
  return readCoordinatorWorkerModsContext(threadId) ?? readWorkflowChildModsContext(threadId)
}

/** Returns the real persisted data owner, never a fabricated synthetic thread row. */
export function readNativeChildModsThread(threadId: string) {
  const child = readNativeChildModsContext(threadId)
  return { child, thread: getThreadCore(child?.parentThreadId ?? threadId) }
}
