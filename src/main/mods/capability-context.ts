import { isSameWorkspacePath } from "../../shared/workspace-path"
import type { CapabilityUsageContext } from "../../shared/mods/capability-usage"
import { isInternalHarnessProjectId } from "../harness-board/internal-project-context"

export interface CapabilityContext {
  usage: CapabilityUsageContext
  identity: string
  projectId?: string
}

interface ContextReaders {
  thread(id: string): { metadata?: unknown } | null
  /** Host-owned project index; this must not come from request arguments. */
  projectWorkspaces(id: string): readonly string[] | undefined
  featureWorkspace?(projectId: string, featureId: string): string | undefined
  hostProject(threadId: string, workspace: string, binding: unknown): boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Classification only. Existing project/Claw entry authorization still applies separately. */
export function resolveCapabilityContext(
  workspace: string,
  threadId: string,
  readers: ContextReaders
): CapabilityContext {
  const seen = new Set<string>()
  const chain: unknown[] = []
  let currentId = threadId
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(currentId)) throw Error("CAPABILITY_CONTEXT_INVALID")
    seen.add(currentId)
    const row = readers.thread(currentId)
    if (!row) throw Error("CAPABILITY_CONTEXT_CHANGED")
    let metadata: Record<string, unknown> | undefined
    try {
      metadata = record(typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata)
    } catch {
      throw Error("CAPABILITY_CONTEXT_INVALID")
    }
    if (
      !metadata ||
      typeof metadata.workspacePath !== "string" ||
      !isSameWorkspacePath(metadata.workspacePath, workspace)
    )
      throw Error("CAPABILITY_CONTEXT_CHANGED")
    chain.push([currentId, metadata.cmb_thread_incarnation ?? "legacy"])
    const host = record(metadata.hostProjectRuntime)
    if (metadata.hostProjectRuntime !== undefined) {
      if (
        !host ||
        typeof host.projectId !== "string" ||
        !host.projectId ||
        !readers.hostProject(currentId, workspace, host)
      )
        throw Error("CAPABILITY_PROJECT_UNAVAILABLE")
      return {
        usage: "project",
        projectId: host.projectId,
        identity: JSON.stringify([workspace, chain, "host", host])
      }
    }
    const feature = record(metadata.harnessFeature)
    const internalLegacy =
      metadata.isInternalFlowRuntime === true &&
      typeof feature?.projectId === "string" &&
      isInternalHarnessProjectId(feature.projectId)
    // Isolated Legacy sessions own an original project, not a parent chat selection.
    // Their project and exact feature workspace still need the host index proof below.
    if (metadata.isInternalFlowRuntime === true && !internalLegacy) {
      if (typeof metadata.parentThreadId !== "string" || !metadata.parentThreadId)
        throw Error("CAPABILITY_CONTEXT_INVALID")
      currentId = metadata.parentThreadId
      continue
    }
    const session = record(metadata.harnessProjectSession)
    const ids = [feature?.projectId, session?.projectId, metadata.harnessProjectId].filter(
      (value) => value !== undefined
    )
    if (
      metadata.harnessFeature !== undefined ||
      metadata.harnessProjectSession !== undefined ||
      metadata.harnessProjectId ||
      metadata.featureId ||
      metadata.isHarnessProjectSession
    ) {
      const id = ids[0]
      if (
        typeof id !== "string" ||
        !id ||
        ids.some((value) => value !== id) ||
        (!feature && !session) ||
        (metadata.harnessFeature !== undefined &&
          (!feature || typeof feature.slug !== "string" || !feature.slug)) ||
        (metadata.harnessProjectSession !== undefined &&
          (!session || typeof session.kind !== "string" || !session.kind)) ||
        (metadata.featureId && metadata.featureId !== feature?.slug)
      )
        throw Error("CAPABILITY_PROJECT_UNAVAILABLE")
      const roots = readers.projectWorkspaces(id)
      const featureWorkspace =
        feature && typeof feature.slug === "string"
          ? readers.featureWorkspace?.(id, feature.slug)
          : undefined
      if (
        !roots ||
        (internalLegacy &&
          (!featureWorkspace || !isSameWorkspacePath(featureWorkspace, workspace))) ||
        (!roots.some((root) => isSameWorkspacePath(root, workspace)) &&
          !(featureWorkspace && isSameWorkspacePath(featureWorkspace, workspace)))
      )
        throw Error("CAPABILITY_PROJECT_UNAVAILABLE")
      return {
        usage: "project",
        projectId: id,
        identity: JSON.stringify([
          workspace,
          chain,
          "legacy",
          id,
          roots,
          featureWorkspace,
          feature,
          session
        ])
      }
    }
    return { usage: "chat", identity: JSON.stringify([workspace, chain, "chat"]) }
  }
  throw Error("CAPABILITY_CONTEXT_INVALID")
}
