import type { Thread } from "../../types"
import { isSameWorkspacePath } from "../../../../shared/workspace-path"

export interface ProjectThreadTarget {
  threadId: string
  projectId: string
  operationId: string
  stageId: string
  pluginDigest: string
  workspace: string
}
/** Hydrate one host-created thread before selecting it; never fetch the complete directory. */
export async function navigateProjectThread(
  target: ProjectThreadTarget,
  access: {
    read(threadId: string): Promise<Thread | null>
    isCurrent(): boolean
    isRetired(threadId: string): boolean
    add(thread: Thread): void
    select(threadId: string): Promise<void>
  }
) {
  const current = () => access.isCurrent() && !access.isRetired(target.threadId)
  if (!current()) return
  const thread = await access.read(target.threadId)
  if (!current()) return
  const binding = thread?.metadata?.hostProjectRuntime as Record<string, unknown> | undefined
  if (
    !thread ||
    thread.thread_id !== target.threadId ||
    !binding ||
    binding.projectId !== target.projectId ||
    binding.operationId !== target.operationId ||
    binding.stageId !== target.stageId ||
    binding.pluginDigest !== target.pluginDigest ||
    typeof thread.metadata?.workspacePath !== "string" ||
    !isSameWorkspacePath(thread.metadata.workspacePath, target.workspace)
  )
    throw Error("PROJECT_THREAD_SCOPE_CHANGED")
  access.add(thread)
  if (current()) await access.select(thread.thread_id)
}
