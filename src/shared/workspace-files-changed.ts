import { normalizeWorkspacePathKey } from "./workspace-path"

export type WorkspaceFilesChangeType = "file" | "meta"

export interface WorkspaceFilePatchEntry {
  path: string
  is_dir: false
  size: number
  modified_at: string
}

export type WorkspaceFilesUpdate =
  | {
      kind: "patch"
      upserts: WorkspaceFilePatchEntry[]
      deletes: string[]
    }
  | { kind: "rescan" }

/** One physical-workspace change broadcast, shared by every associated task. */
export interface WorkspaceFilesChangedPayload {
  threadIds: string[]
  workspacePath: string
  changeType: WorkspaceFilesChangeType
  /**
   * Known file paths are resolved in the main process and sent as a bounded
   * patch. Missing/legacy values deliberately fall back to a full scan.
   */
  update?: WorkspaceFilesUpdate
}

interface LegacyWorkspaceFilesChangedPayload {
  threadId?: unknown
  threadIds?: unknown
  workspacePath?: unknown
  changeType?: unknown
  update?: unknown
}

const MAX_PATCH_PATHS = 128

function normalizeVirtualFilePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) return undefined
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/")
  const relative = normalized.replace(/^\/+/, "")
  if (!relative || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    return undefined
  }
  return `/${relative}`
}

function normalizeWorkspaceFilesUpdate(value: unknown): WorkspaceFilesUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "rescan" }
  const update = value as {
    kind?: unknown
    upserts?: unknown
    deletes?: unknown
  }
  if (update.kind !== "patch") return { kind: "rescan" }
  if (!Array.isArray(update.upserts) || !Array.isArray(update.deletes)) {
    return { kind: "rescan" }
  }
  if (update.upserts.length + update.deletes.length > MAX_PATCH_PATHS) {
    return { kind: "rescan" }
  }

  const upserts: WorkspaceFilePatchEntry[] = []
  for (const candidate of update.upserts) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { kind: "rescan" }
    }
    const entry = candidate as Record<string, unknown>
    const filePath = normalizeVirtualFilePath(entry.path)
    if (
      !filePath ||
      entry.is_dir !== false ||
      typeof entry.size !== "number" ||
      !Number.isFinite(entry.size) ||
      typeof entry.modified_at !== "string"
    ) {
      return { kind: "rescan" }
    }
    upserts.push({
      path: filePath,
      is_dir: false,
      size: entry.size,
      modified_at: entry.modified_at
    })
  }

  const deletes: string[] = []
  for (const candidate of update.deletes) {
    const filePath = normalizeVirtualFilePath(candidate)
    if (!filePath) return { kind: "rescan" }
    deletes.push(filePath)
  }

  return { kind: "patch", upserts, deletes }
}

/**
 * Normalize both the batched contract and the former one-thread IPC payload.
 * Keeping this adapter in preload lets older main-process senders coexist with
 * a newer renderer during a hot reload without reintroducing per-thread work.
 */
export function normalizeWorkspaceFilesChangedPayload(
  value: unknown
): WorkspaceFilesChangedPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const payload = value as LegacyWorkspaceFilesChangedPayload
  const workspacePath =
    typeof payload.workspacePath === "string"
      ? normalizeWorkspacePathKey(payload.workspacePath)
      : ""
  if (!workspacePath) return undefined

  const rawThreadIds = Array.isArray(payload.threadIds)
    ? payload.threadIds
    : [payload.threadId]
  const threadIds = Array.from(
    new Set(
      rawThreadIds.flatMap((threadId) =>
        typeof threadId === "string" && threadId.trim() ? [threadId.trim()] : []
      )
    )
  )
  if (threadIds.length === 0) return undefined

  return {
    threadIds,
    workspacePath,
    changeType: payload.changeType === "meta" ? "meta" : "file",
    update: normalizeWorkspaceFilesUpdate(payload.update)
  }
}
