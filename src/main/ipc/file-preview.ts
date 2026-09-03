import { type IpcMain, type WebContents } from "electron"
import path from "node:path"
import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  WORKSPACE_FILE_PREVIEW_MAX_LANE_LENGTH,
  WORKSPACE_FILE_PREVIEW_MAX_TOKEN_LENGTH,
  type WorkspaceFilePreviewCancelRequest,
  type WorkspaceFilePreviewOpenMediaRequest,
  type WorkspaceFilePreviewOpenMediaResult,
  type WorkspaceFilePreviewReadRequest,
  type WorkspaceFilePreviewReadResult,
  type WorkspaceFilePreviewReleaseRequest,
  type WorkspaceFilePreviewSource,
  type ToolFilePreviewGrantRequest,
  type ToolFilePreviewGrantResult
} from "../../shared/workspace-file-preview"
import { readThreadWorkspacePathInWorker } from "../thread-metadata-hydration/client"
import {
  resolveExternalFileReadGrant,
  revokeExternalFileReadGrantsForOwner
} from "../services/external-file-read-tokens"
import { authorizeTrustedToolFilePreview } from "../services/trusted-tool-file-preview"
import { openStableFileHandle } from "../services/stable-file-handle"
import { getWorkspaceFilePreviewClient } from "../workspace-file-preview/client"
import { workspaceFilePreviewFailure } from "../workspace-file-preview/errors"
import type { WorkspaceFilePreviewWorkerSource } from "../workspace-file-preview/protocol"
import { mediaPreviewUrl, type MediaPreviewEntry } from "../workspace-file-preview/media-registry"
import { workspaceFilePreviewMediaRegistry } from "../workspace-file-preview/media-protocol"

interface ActivePreviewRequest {
  ownerId: number
  lane: string
  requestToken: string
  latestKey: string
}

const activeRequests = new Map<string, ActivePreviewRequest>()
const cleanupOwners = new Set<number>()

function validBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
}

function validateSource(source: unknown): source is WorkspaceFilePreviewSource {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false
  const record = source as Record<string, unknown>
  const filePath = validBoundedString(record.filePath, 32_768)
  const hasThreadId = Object.prototype.hasOwnProperty.call(record, "threadId")
  const hasExternalGrant = Object.prototype.hasOwnProperty.call(record, "externalGrant")
  if (hasThreadId === hasExternalGrant) return false
  const workspacePathKind = record.workspacePathKind
  const validWorkspacePathKind =
    workspacePathKind === undefined ||
    workspacePathKind === "relative" ||
    workspacePathKind === "absolute" ||
    workspacePathKind === "auto"
  return hasThreadId
    ? validBoundedString(record.threadId, 256) && filePath && validWorkspacePathKind
    : validBoundedString(record.externalGrant, 256) && filePath && workspacePathKind === undefined
}

function validateBaseRequest(
  request: unknown
): request is WorkspaceFilePreviewReadRequest | WorkspaceFilePreviewOpenMediaRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false
  const record = request as Record<string, unknown>
  return (
    validateSource(record.source) &&
    validBoundedString(record.lane, WORKSPACE_FILE_PREVIEW_MAX_LANE_LENGTH) &&
    validBoundedString(record.requestToken, WORKSPACE_FILE_PREVIEW_MAX_TOKEN_LENGTH)
  )
}

function laneMatchesPrefix(lane: string, prefix: string): boolean {
  return lane === prefix || lane.startsWith(`${prefix}:`)
}

function cleanupOwner(ownerId: number): void {
  const client = getWorkspaceFilePreviewClient()
  for (const [key, active] of activeRequests) {
    if (active.ownerId !== ownerId) continue
    activeRequests.delete(key)
    client.cancelLatest(active.latestKey)
  }
  workspaceFilePreviewMediaRegistry.revokeOwner(ownerId)
  revokeExternalFileReadGrantsForOwner(ownerId)
  cleanupOwners.delete(ownerId)
}

function attachOwnerCleanup(sender: WebContents): void {
  if (cleanupOwners.has(sender.id) || sender.isDestroyed()) return
  cleanupOwners.add(sender.id)
  sender.once("destroyed", () => cleanupOwner(sender.id))
}

function beginRequest(
  sender: WebContents,
  lane: string,
  requestToken: string
): ActivePreviewRequest {
  attachOwnerCleanup(sender)
  const latestKey = `${sender.id}:${lane}`
  const previous = activeRequests.get(latestKey)
  if (previous) getWorkspaceFilePreviewClient().cancelLatest(previous.latestKey)
  const active = { ownerId: sender.id, lane, requestToken, latestKey }
  activeRequests.set(latestKey, active)
  return active
}

function isCurrent(active: ActivePreviewRequest): boolean {
  return activeRequests.get(active.latestKey) === active
}

function finishRequest(active: ActivePreviewRequest): void {
  if (isCurrent(active)) activeRequests.delete(active.latestKey)
}

async function prepareWorkerSource(
  source: WorkspaceFilePreviewSource,
  ownerId: number
): Promise<{
  source: WorkspaceFilePreviewWorkerSource
  workspacePath?: string
  trustedRootPath: string
}> {
  if ("externalGrant" in source) {
    const resolved = await resolveExternalFileReadGrant(
      source.externalGrant,
      ownerId,
      source.filePath
    )
    if ("error" in resolved) throw new Error(resolved.error)
    return {
      source: {
        externalFullPath: resolved.filePath,
        trustedRootPath: resolved.rootPath
      },
      trustedRootPath: resolved.rootPath
    }
  }
  const workspacePath = await readThreadWorkspacePathInWorker(source.threadId)
  if (!workspacePath) throw new Error("No workspace folder linked")
  return {
    source: {
      threadId: source.threadId,
      filePath: source.filePath,
      workspacePathKind: source.workspacePathKind ?? "relative"
    },
    workspacePath,
    trustedRootPath: workspacePath
  }
}

function mimeTypeForPath(filePath: string, requestedMimeType?: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
    pdf: "application/pdf",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    flac: "audio/flac"
  }
  if (known[ext]) return known[ext]
  const safeRequestedMimeTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/x-icon",
    "image/avif",
    "application/pdf",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/x-matroska",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
    "audio/flac"
  ])
  if (requestedMimeType && safeRequestedMimeTypes.has(requestedMimeType)) {
    return requestedMimeType
  }
  return "application/octet-stream"
}

function inlineMediaPolicy(mimeType: string, size: number): { allowed: boolean; reason?: string } {
  if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
    return { allowed: true }
  }
  if (mimeType === "application/pdf") {
    return size <= 64 * 1024 * 1024
      ? { allowed: true }
      : { allowed: false, reason: "PDF 超过 64 MiB，不在应用内嵌入" }
  }
  if (mimeType.startsWith("image/")) {
    return size <= 32 * 1024 * 1024
      ? { allowed: true }
      : { allowed: false, reason: "图片超过 32 MiB，不在应用内解码" }
  }
  return { allowed: false, reason: "该二进制格式不支持应用内预览" }
}

export function registerWorkspaceFilePreviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "workspace:authorizeToolFilePreview",
    async (event, request: ToolFilePreviewGrantRequest): Promise<ToolFilePreviewGrantResult> => {
      if (
        !request ||
        typeof request !== "object" ||
        !validBoundedString(request.threadId, 256) ||
        !validBoundedString(request.toolCallId, 1_024)
      ) {
        return { success: false, error: "Invalid tool file preview authorization request" }
      }

      const workspacePath = await readThreadWorkspacePathInWorker(request.threadId).catch(
        () => null
      )
      const issued = authorizeTrustedToolFilePreview(
        request.threadId,
        request.toolCallId,
        event.sender.id,
        workspacePath
      )
      if (!issued.success) return issued
      if (issued.external) attachOwnerCleanup(event.sender)
      return issued
    }
  )

  ipcMain.handle(
    "workspace:filePreviewRead",
    async (
      event,
      request: WorkspaceFilePreviewReadRequest
    ): Promise<WorkspaceFilePreviewReadResult> => {
      if (!validateBaseRequest(request)) {
        return {
          success: false,
          error: "Invalid workspace file preview request",
          errorCode: "invalid-request"
        }
      }
      const offset = request.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0) {
        return {
          success: false,
          error: "Invalid workspace file preview offset",
          errorCode: "invalid-request"
        }
      }

      const active = beginRequest(event.sender, request.lane, request.requestToken)
      const client = getWorkspaceFilePreviewClient()
      try {
        const prepared = await prepareWorkerSource(request.source, event.sender.id)
        if (!isCurrent(active))
          throw Object.assign(new Error("Preview superseded"), {
            name: WORKSPACE_FILE_PREVIEW_CANCELLED
          })
        const page = await client.readText(
          prepared.source,
          prepared.workspacePath,
          offset,
          active.latestKey
        )
        if (!isCurrent(active))
          throw Object.assign(new Error("Preview superseded"), {
            name: WORKSPACE_FILE_PREVIEW_CANCELLED
          })
        return page.result
      } catch (error) {
        return workspaceFilePreviewFailure(error)
      } finally {
        finishRequest(active)
      }
    }
  )

  ipcMain.handle(
    "workspace:filePreviewOpenMedia",
    async (
      event,
      request: WorkspaceFilePreviewOpenMediaRequest
    ): Promise<WorkspaceFilePreviewOpenMediaResult> => {
      if (!validateBaseRequest(request)) {
        return {
          success: false,
          error: "Invalid workspace media preview request",
          errorCode: "invalid-request"
        }
      }
      const active = beginRequest(event.sender, request.lane, request.requestToken)
      const client = getWorkspaceFilePreviewClient()
      try {
        const prepared = await prepareWorkerSource(request.source, event.sender.id)
        if (!isCurrent(active))
          throw Object.assign(new Error("Preview superseded"), {
            name: WORKSPACE_FILE_PREVIEW_CANCELLED
          })
        const inspected = await client.inspect(
          prepared.source,
          prepared.workspacePath,
          active.latestKey
        )
        if (!isCurrent(active))
          throw Object.assign(new Error("Preview superseded"), {
            name: WORKSPACE_FILE_PREVIEW_CANCELLED
          })
        const stableFile = await openStableFileHandle(
          prepared.trustedRootPath,
          inspected.resolvedPath
        )
        if (!isCurrent(active)) {
          await stableFile.handle.close().catch(() => undefined)
          throw Object.assign(new Error("Preview superseded"), {
            name: WORKSPACE_FILE_PREVIEW_CANCELLED
          })
        }
        const displayPath =
          "externalGrant" in request.source ? stableFile.filePath : request.source.filePath
        const mimeType = mimeTypeForPath(displayPath, request.mimeType)
        const inlinePolicy = inlineMediaPolicy(mimeType, stableFile.size)
        let transferred = false
        try {
          const entry = workspaceFilePreviewMediaRegistry.issue({
            ownerId: event.sender.id,
            lane: request.lane,
            requestToken: request.requestToken,
            fileHandle: stableFile.handle,
            filePath: stableFile.filePath,
            fileName: path.basename(displayPath),
            mimeType,
            size: stableFile.size,
            modified_at: stableFile.modified_at
          } satisfies Omit<MediaPreviewEntry, "token" | "createdAt" | "lastAccessAt">)
          transferred = true
          return {
            success: true,
            previewUrl: mediaPreviewUrl(entry),
            inlineAllowed: inlinePolicy.allowed,
            inlineBlockedReason: inlinePolicy.reason,
            size: entry.size,
            modified_at: entry.modified_at,
            mimeType: entry.mimeType
          }
        } finally {
          if (!transferred) await stableFile.handle.close().catch(() => undefined)
        }
      } catch (error) {
        return workspaceFilePreviewFailure(error)
      } finally {
        finishRequest(active)
      }
    }
  )

  ipcMain.handle(
    "workspace:filePreviewCancel",
    (event, request: WorkspaceFilePreviewCancelRequest): { success: boolean } => {
      if (
        !request ||
        !validBoundedString(request.lanePrefix, WORKSPACE_FILE_PREVIEW_MAX_LANE_LENGTH) ||
        !validBoundedString(request.requestToken, WORKSPACE_FILE_PREVIEW_MAX_TOKEN_LENGTH)
      ) {
        return { success: false }
      }
      const client = getWorkspaceFilePreviewClient()
      for (const [key, active] of activeRequests) {
        if (
          active.ownerId !== event.sender.id ||
          active.requestToken !== request.requestToken ||
          !laneMatchesPrefix(active.lane, request.lanePrefix)
        ) {
          continue
        }
        activeRequests.delete(key)
        client.cancelLatest(active.latestKey)
      }
      workspaceFilePreviewMediaRegistry.revokeLane(
        event.sender.id,
        request.lanePrefix,
        request.requestToken
      )
      return { success: true }
    }
  )

  ipcMain.handle(
    "workspace:filePreviewRelease",
    (event, request: WorkspaceFilePreviewReleaseRequest): { success: boolean } => ({
      success:
        !!request &&
        typeof request.previewUrl === "string" &&
        workspaceFilePreviewMediaRegistry.revokeUrl(event.sender.id, request.previewUrl)
    })
  )
}
