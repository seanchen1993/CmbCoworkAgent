export type ResourcePanelOverlayMode = "preview" | "git" | "browser"

/** Inline text preview (e.g. a remote requirement document without a workspace file). */
export interface ResourcePanelInlinePreview {
  title: string
  content: string
  error?: string
}

export interface ResourcePanelOverlayOpenOptions {
  /** Optional URL that the built-in browser should open when the overlay shows. */
  browserUrl?: string
  /** Optional inline text rendered by the preview module instead of a file. */
  inlinePreview?: ResourcePanelInlinePreview
}

export interface ResourcePanelOverlayOpenDetail {
  mode: ResourcePanelOverlayMode
  browserUrl?: string
  inlinePreview?: ResourcePanelInlinePreview
}

const RESOURCE_PANEL_OVERLAY_OPEN_EVENT = "resource-panel-overlay:open"

export function openResourcePanelOverlay(
  mode: ResourcePanelOverlayMode,
  options?: ResourcePanelOverlayOpenOptions
): void {
  const detail: ResourcePanelOverlayOpenDetail = {
    mode,
    ...(options?.browserUrl ? { browserUrl: options.browserUrl } : {}),
    ...(options?.inlinePreview ? { inlinePreview: options.inlinePreview } : {})
  }
  window.dispatchEvent(
    new CustomEvent<ResourcePanelOverlayOpenDetail>(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, {
      detail
    })
  )
}

export function onOpenResourcePanelOverlay(
  callback: (detail: ResourcePanelOverlayOpenDetail) => void
): () => void {
  const handleOpen = (event: Event): void => {
    const detail = (event as CustomEvent<ResourcePanelOverlayOpenDetail>).detail
    if (!detail) return
    const mode = detail.mode
    if (mode === "preview" || mode === "git" || mode === "browser") callback(detail)
  }
  window.addEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
  return () => window.removeEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
}
