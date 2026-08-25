export interface OpenResourcePreviewDetail {
  threadId: string
  filePath: string
  /** Main-issued capability for a trusted non-workspace file. */
  externalPreviewGrant?: string
}

const RESOURCE_PREVIEW_OPEN_EVENT = "resource-preview:open"

export function emitOpenResourcePreview(detail: OpenResourcePreviewDetail): void {
  window.dispatchEvent(new CustomEvent<OpenResourcePreviewDetail>(RESOURCE_PREVIEW_OPEN_EVENT, { detail }))
}

export function onOpenResourcePreview(
  callback: (detail: OpenResourcePreviewDetail) => void
): () => void {
  const handler = (event: Event): void => {
    const customEvent = event as CustomEvent<OpenResourcePreviewDetail>
    if (!customEvent.detail?.threadId || !customEvent.detail?.filePath) return
    callback(customEvent.detail)
  }
  window.addEventListener(RESOURCE_PREVIEW_OPEN_EVENT, handler as EventListener)
  return () => {
    window.removeEventListener(RESOURCE_PREVIEW_OPEN_EVENT, handler as EventListener)
  }
}

