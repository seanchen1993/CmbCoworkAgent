import type { Thread } from "../types"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

export interface HostProjectThreadTarget {
  threadId: string
  projectId: string
  operationId: string
  stageId: string
  pluginDigest: string
  workspace: string
}

/** Routing facts only. The destination re-reads both the durable thread and project. */
export function readHostProjectThreadTarget(
  thread: Pick<Thread, "thread_id" | "metadata"> | null | undefined
): HostProjectThreadTarget | null {
  const binding = thread?.metadata?.hostProjectRuntime
  const workspace = thread?.metadata?.workspacePath
  if (
    !binding ||
    typeof binding !== "object" ||
    Array.isArray(binding) ||
    typeof workspace !== "string" ||
    !workspace.trim()
  )
    return null
  const fields = binding as Record<string, unknown>
  for (const field of ["projectId", "operationId", "stageId", "pluginDigest"])
    if (typeof fields[field] !== "string" || !fields[field] || fields[field].length > 256)
      return null
  return {
    threadId: thread!.thread_id,
    projectId: fields.projectId as string,
    operationId: fields.operationId as string,
    stageId: fields.stageId as string,
    pluginDigest: fields.pluginDigest as string,
    workspace
  }
}

export function sameHostProjectThreadTarget(
  left: HostProjectThreadTarget,
  right: HostProjectThreadTarget | null
): boolean {
  return (
    !!right &&
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.operationId === right.operationId &&
    left.stageId === right.stageId &&
    left.pluginDigest === right.pluginDigest &&
    isSameWorkspacePath(left.workspace, right.workspace)
  )
}

/** A historical operation may precede a plan migration; the stable project and directory win. */
export async function resolveHostProjectThread(
  target: HostProjectThreadTarget,
  access: {
    readThread(id: string): Promise<Thread | null>
    readProject(id: string): Promise<{ project: { projectId: string; workspace: string } }>
    isCurrent(): boolean
  }
): Promise<string | undefined> {
  if (!access.isCurrent()) return undefined
  const thread = await access.readThread(target.threadId)
  if (!access.isCurrent()) return undefined
  if (!sameHostProjectThreadTarget(target, readHostProjectThreadTarget(thread)))
    throw Error("HOST_PROJECT_NAVIGATION_CHANGED")
  const { project } = await access.readProject(target.projectId)
  if (!access.isCurrent()) return undefined
  if (
    project.projectId !== target.projectId ||
    !isSameWorkspacePath(project.workspace, target.workspace)
  )
    throw Error("HOST_PROJECT_NAVIGATION_CHANGED")
  return project.projectId
}
