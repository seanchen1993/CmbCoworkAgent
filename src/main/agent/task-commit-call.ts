import { AsyncLocalStorage } from "node:async_hooks"

/** Provider-issued identity follows one execute invocation through the sandbox. */
interface CallBinding {
  version: string
  repositoryPaths: string[]
}
export const taskCommitCall = new AsyncLocalStorage<{
  threadId: string
  callId: string
  binding?: CallBinding | null
}>()

export async function withTaskCommitCall<T>(
  threadId: string,
  callId: string,
  invoke: () => T | Promise<T>
) {
  const { getDb } = await import("../db")
  let binding: CallBinding | null = null
  try {
    // Ordinary tasks pay one indexed existence probe, without hydrating thread metadata.
    if (
      getDb().exec("SELECT 1 FROM task_commit_bindings WHERE thread_id=? AND card IS NOT NULL", [
        threadId
      ]).length
    ) {
      const current = await (
        await import("../services/task-commit-binding")
      ).readTaskCommitBinding(threadId)
      if (current) binding = { version: current.version, repositoryPaths: current.repositoryPaths }
    }
  } catch {
    // Missing or unreadable authorization disables capture for this invocation.
  }
  return taskCommitCall.run({ threadId, callId, binding }, invoke)
}
