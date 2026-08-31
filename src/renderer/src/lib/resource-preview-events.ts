import type { WorkspaceFilePreviewWorkspacePathKind } from "../../../shared/workspace-file-preview"
import { inferWorkspacePreviewPathKind } from "./resource-preview-paths"

export interface OpenResourcePreviewDetail {
  threadId: string
  filePath: string
  workspacePathKind: WorkspaceFilePreviewWorkspacePathKind
  /** Main-issued capability for a trusted non-workspace file. */
  externalPreviewGrant?: string
  /** Expiry and authoritative run identity used for operation-triggered renewal. */
  externalPreviewGrantExpiresAt?: number
  externalPreviewProjectId?: string
  externalPreviewSlug?: string
}

export type OpenResourcePreviewRequest = Omit<OpenResourcePreviewDetail, "workspacePathKind"> & {
  workspacePathKind?: WorkspaceFilePreviewWorkspacePathKind
}

const RESOURCE_PREVIEW_OPEN_EVENT = "resource-preview:open"

function normalizeOpenResourcePreviewDetail(
  detail: OpenResourcePreviewRequest
): OpenResourcePreviewDetail {
  return {
    ...detail,
    workspacePathKind:
      detail.workspacePathKind ??
      inferWorkspacePreviewPathKind(detail.filePath, window.electron.process.platform)
  }
}

export function emitOpenResourcePreview(detail: OpenResourcePreviewRequest): void {
  window.dispatchEvent(
    new CustomEvent<OpenResourcePreviewDetail>(RESOURCE_PREVIEW_OPEN_EVENT, {
      detail: normalizeOpenResourcePreviewDetail(detail)
    })
  )
}

export function onOpenResourcePreview(
  callback: (detail: OpenResourcePreviewDetail) => void
): () => void {
  const handler = (event: Event): void => {
    const customEvent = event as CustomEvent<OpenResourcePreviewRequest>
    if (!customEvent.detail?.threadId || !customEvent.detail?.filePath) return
    callback(normalizeOpenResourcePreviewDetail(customEvent.detail))
  }
  window.addEventListener(RESOURCE_PREVIEW_OPEN_EVENT, handler as EventListener)
  return () => {
    window.removeEventListener(RESOURCE_PREVIEW_OPEN_EVENT, handler as EventListener)
  }
}
