import { useCallback, useEffect, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useAppStore } from "@/lib/store"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"

export type ResourcePanelOverlayMode = "preview" | "git" | "browser"

const RESOURCE_PANEL_OVERLAY_OPEN_EVENT = "resource-panel-overlay:open"

export function openResourcePanelOverlay(mode: ResourcePanelOverlayMode): void {
  window.dispatchEvent(
    new CustomEvent<ResourcePanelOverlayMode>(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, {
      detail: mode
    })
  )
}

interface ResourcePanelOverlayProps {
  isAgentFocusActive: boolean
  renderedMainView: string
  renderedPanelThreadId: string | null
}

export function ResourcePanelOverlay({
  isAgentFocusActive,
  renderedMainView,
  renderedPanelThreadId
}: ResourcePanelOverlayProps): React.JSX.Element | null {
  const rightPanelCollapsed = useAppStore((state) => state.rightPanelCollapsed)
  const setRightModule = useAppStore((state) => state.setRightModule)
  const activeThreadId = renderedPanelThreadId
  const standardRightPanelMounted =
    !isAgentFocusActive &&
    !rightPanelCollapsed &&
    (renderedMainView === "thread" || renderedMainView === "harness") &&
    Boolean(renderedPanelThreadId)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ResourcePanelOverlayMode>("preview")
  const { request: previewRequest, clear: clearPreviewRequest } = useResourcePreviewRequest(
    activeThreadId,
    !standardRightPanelMounted
  )
  const overlayThreadId = renderedPanelThreadId

  const close = useCallback(() => {
    setOpen(false)
    clearPreviewRequest()
  }, [clearPreviewRequest])

  const selectMode = useCallback(
    (nextMode: ResourcePanelOverlayMode) => {
      if (standardRightPanelMounted) {
        setRightModule(nextMode)
        return
      }
      setMode(nextMode)
      setOpen(true)
    },
    [setRightModule, standardRightPanelMounted]
  )

  useEffect(() => {
    const handleOpen = (event: Event): void => {
      const nextMode = (event as CustomEvent<ResourcePanelOverlayMode>).detail
      if (nextMode !== "preview" && nextMode !== "git" && nextMode !== "browser") return
      selectMode(nextMode)
    }
    window.addEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
    return () => window.removeEventListener(RESOURCE_PANEL_OVERLAY_OPEN_EVENT, handleOpen)
  }, [selectMode])

  useEffect(() => {
    if (!previewRequest || standardRightPanelMounted) return
    setMode(/\.html?$/i.test(previewRequest.filePath) ? "browser" : "preview")
    setOpen(true)
  }, [previewRequest, standardRightPanelMounted])

  const handleBrowserPanelRequest = useCallback(() => {
    selectMode("browser")
  }, [selectMode])

  useBrowserViewLifecycle({
    currentThreadId: renderedMainView === "thread" ? activeThreadId : null,
    harnessSessionThreadId: renderedMainView === "harness" ? activeThreadId : null,
    mainView: renderedMainView,
    rightPanelCollapsed,
    isAgentFocusActive,
    overlayModule: open ? mode : null,
    overlayThreadId,
    onRequestBrowserPanel: handleBrowserPanelRequest
  })

  if (!overlayThreadId || standardRightPanelMounted) return null

  return (
    <OverlayDrawer
      open={open}
      title={mode === "git" ? "Git 面板" : mode === "browser" ? "内置浏览器" : "文件预览"}
      onClose={close}
    >
      <RightPanel
        threadId={overlayThreadId}
        moduleMode={mode}
        showSystemConstraints={renderedMainView === "harness"}
        resourcePreviewRequest={mode === "preview" || mode === "browser" ? previewRequest : null}
        onResourcePreviewRequestHandled={clearPreviewRequest}
        listenForResourcePreview={false}
        onRequestPreviewMode={() => setMode("preview")}
        onRequestBrowserMode={() => setMode("browser")}
        onRequestWorkMode={close}
      />
    </OverlayDrawer>
  )
}
