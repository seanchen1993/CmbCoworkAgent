import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "../harness-board/project-action-scope"

/** Only a host-created internal flow child may inherit its ordinary parent's selection. */
export function isClawThread(
  threadId: string,
  read: (id: string) => { metadata?: unknown } | null,
  canonical: (workspace: string) => string = (workspace) => workspace
): boolean {
  return resolveClawThread(threadId, read, canonical) !== null
}

/** Internal children inherit the trusted ordinary root, never their own project default. */
export function resolveClawThread(
  threadId: string,
  read: (id: string) => { metadata?: unknown } | null,
  canonical: (workspace: string) => string = (workspace) => workspace
): { threadId: string; identity: string } | null {
  const metadata = (id: string): Record<string, unknown> | null => {
    const raw = read(id)?.metadata
    const value = projectActionFlowMetadata(id, typeof raw === "string" ? JSON.parse(raw) : raw)
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  let currentId = threadId
  let current = metadata(currentId)
  const seen = new Set([threadId])
  for (let depth = 0; depth < 32; depth++) {
    if (isOrdinaryFlowMetadata(current))
      return {
        threadId: currentId,
        identity: JSON.stringify([currentId, current?.cmb_thread_incarnation ?? "legacy"])
      }
    if (current?.isInternalFlowRuntime !== true) return null
    if (typeof current.parentThreadId !== "string" || seen.has(current.parentThreadId))
      throw Error("CLAW_PARENT_SCOPE_INVALID")
    seen.add(current.parentThreadId)
    const parent = metadata(current.parentThreadId)
    if (
      !parent ||
      typeof current.workspacePath !== "string" ||
      typeof parent.workspacePath !== "string" ||
      canonical(current.workspacePath) !== canonical(parent.workspacePath)
    )
      throw Error("CLAW_PARENT_SCOPE_INVALID")
    currentId = current.parentThreadId
    current = parent
  }
  throw Error("CLAW_PARENT_SCOPE_INVALID")
}
