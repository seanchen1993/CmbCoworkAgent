import type { WorkspaceFilePreviewWorkspacePathKind } from "../../../shared/workspace-file-preview"
import { inferWorkspacePreviewPathKind } from "./resource-preview-paths"

export interface OpenResourcePreviewDetail {
  threadId: string
  filePath: string
  /** Monotonic user/application intent used to reject late async authorization results. */
  intentId: number
  workspacePathKind: WorkspaceFilePreviewWorkspacePathKind
  /** Main-issued capability for a trusted non-workspace file. */
  externalPreviewGrant?: string
  /** Expiry and authoritative run identity used for operation-triggered renewal. */
  externalPreviewGrantExpiresAt?: number
  externalPreviewProjectId?: string
  externalPreviewSlug?: string
  /** Successful main-process file tool used to issue and renew an external grant. */
  toolCallId?: string
}

export type OpenResourcePreviewRequest = Omit<
  OpenResourcePreviewDetail,
  "intentId" | "workspacePathKind"
> & {
  intentId?: number
  workspacePathKind?: WorkspaceFilePreviewWorkspacePathKind
}

const RESOURCE_PREVIEW_OPEN_EVENT = "resource-preview:open"
const RESOURCE_PREVIEW_THREAD_INTENT_LIMIT = 5_000
let nextResourcePreviewIntentId = 0
const latestResourcePreviewIntentByThread = new Map<string, number>()

export function beginOpenResourcePreviewIntent(threadId: string): number {
  nextResourcePreviewIntentId += 1
  if (
    !latestResourcePreviewIntentByThread.has(threadId) &&
    latestResourcePreviewIntentByThread.size >= RESOURCE_PREVIEW_THREAD_INTENT_LIMIT
  ) {
    const oldestThreadId = latestResourcePreviewIntentByThread.keys().next().value
    if (oldestThreadId) latestResourcePreviewIntentByThread.delete(oldestThreadId)
  }
  latestResourcePreviewIntentByThread.delete(threadId)
  latestResourcePreviewIntentByThread.set(threadId, nextResourcePreviewIntentId)
  return nextResourcePreviewIntentId
}

export function isCurrentOpenResourcePreviewIntent(
  threadId: string,
  intentId: number,
  latestAppliedIntentId: number
): boolean {
  return (
    Number.isSafeInteger(intentId) &&
    intentId > latestAppliedIntentId &&
    latestResourcePreviewIntentByThread.get(threadId) === intentId
  )
}

function normalizeOpenResourcePreviewDetail(
  detail: OpenResourcePreviewRequest
): OpenResourcePreviewDetail {
  return {
    ...detail,
    intentId:
      Number.isSafeInteger(detail.intentId) &&
      Number(detail.intentId) > 0 &&
      Number(detail.intentId) <= nextResourcePreviewIntentId
        ? Number(detail.intentId)
        : beginOpenResourcePreviewIntent(detail.threadId),
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
