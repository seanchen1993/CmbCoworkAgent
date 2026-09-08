export type ResourcePanelOverlayMode = "preview" | "git" | "browser"

const RESOURCE_PANEL_OVERLAY_OPEN_EVENT = "resource-panel-overlay:open"

export function openResourcePanelOverlay(mode: ResourcePanelOverlayMode): void {
  window.dispatchEvent(
    new CustomEvent<ResourcePanelOverlayMode>(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, {
      detail: mode
    })
  )
}

export function onOpenResourcePanelOverlay(
  callback: (mode: ResourcePanelOverlayMode) => void
): () => void {
  const handleOpen = (event: Event): void => {
    const mode = (event as CustomEvent<ResourcePanelOverlayMode>).detail
    if (mode === "preview" || mode === "git" || mode === "browser") callback(mode)
  }
  window.addEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
  return () => window.removeEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
}
