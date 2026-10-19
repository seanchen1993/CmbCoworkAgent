import { isOrdinaryFlowMetadata } from "../../shared/mods/flows/scope"
import { projectActionFlowMetadata } from "../harness-board/project-action-scope"
import { isInternalHarnessProjectId } from "../harness-board/internal-project-context"

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
    const original = typeof raw === "string" ? JSON.parse(raw) : raw
    const value = projectActionFlowMetadata(id, original)
    // Keep the original action-scope assertion above, but its writable projection must not
    // turn an isolated Host into an ordinary Claw owner or a child requiring a chat parent.
    if (value && typeof value === "object" && !Array.isArray(value) &&
      original?.isInternalFlowRuntime === true && original.hostProjectRuntime)
      return { ...value, hostProjectRuntime: original.hostProjectRuntime }
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }
  let currentId = threadId
  let current = metadata(currentId)
  const seen = new Set([threadId])
  for (let depth = 0; depth < 32; depth++) {
    const feature = current?.harnessFeature as { projectId?: unknown } | undefined
    if (
      current?.isInternalFlowRuntime === true &&
      (current.hostProjectRuntime ||
        (typeof feature?.projectId === "string" && isInternalHarnessProjectId(feature.projectId)))
    )
      return null
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
