import { useCallback, useEffect, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useAppStore } from "@/lib/store"
import type { RightModule } from "@/lib/store"
import {
  onOpenResourcePanelOverlay,
  type ResourcePanelOverlayMode
} from "@/lib/resource-panel-overlay-events"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"
import { useProtectedFunctionPreview } from "@/lib/use-protected-function-preview"

interface ResourcePanelOverlayProps {
  isAgentFocusActive: boolean
  renderedMainView: string
  renderedPanelThreadId: string | null
  moduleMode?: RightModule
}

export function ResourcePanelOverlay({
  isAgentFocusActive,
  renderedMainView,
  renderedPanelThreadId,
  moduleMode
}: ResourcePanelOverlayProps): React.JSX.Element | null {
  const rightPanelCollapsed = useAppStore((state) => state.rightPanelCollapsed)
  const storedRightModule = useAppStore((state) => state.rightModule)
  const rightModule = moduleMode ?? storedRightModule
  const setRightModule = useAppStore((state) => state.setRightModule)
  const activeThreadId = renderedPanelThreadId
  const standardRightPanelMounted =
    !isAgentFocusActive &&
    !rightPanelCollapsed &&
    rightModule !== "claw" &&
    (renderedMainView === "thread" || renderedMainView === "harness") &&
    Boolean(renderedPanelThreadId)
  const [open, setOpen] = useState(false)
  const [protectedOnlyOpen, setProtectedOnlyOpen] = useState(false)
  const [mode, setMode] = useState<ResourcePanelOverlayMode>("preview")
  const handlePreviewRequest = useCallback((): void => {
    setProtectedOnlyOpen(false)
    setMode("preview")
    setOpen(true)
  }, [])
  const handleProtectedPreviewRequest = useCallback((): void => {
    setProtectedOnlyOpen(true)
    setMode("preview")
    setOpen(true)
  }, [])
  const { request: previewRequest, clear: clearPreviewRequest } = useResourcePreviewRequest(
    activeThreadId,
    !standardRightPanelMounted,
    handlePreviewRequest
  )
  const { request: protectedPreview, clear: clearProtectedPreview } = useProtectedFunctionPreview(
    activeThreadId, !standardRightPanelMounted, handleProtectedPreviewRequest
  )
  const overlayThreadId = renderedPanelThreadId

  // A drawer stops owning the surface when the original panel returns or its request ends.
  // Adopt that state before painting, so collapsing the panel cannot revive an old drawer.
  const protectedPreviewEnded = protectedOnlyOpen && open && mode === "preview" && !protectedPreview
  if (open && (standardRightPanelMounted || protectedPreviewEnded)) {
    setOpen(false)
    if (protectedPreviewEnded) setProtectedOnlyOpen(false)
  }

  const close = useCallback(() => {
    setOpen(false)
    setProtectedOnlyOpen(false)
    clearPreviewRequest()
    clearProtectedPreview()
  }, [clearPreviewRequest, clearProtectedPreview])

  useEffect(() => {
    if (!standardRightPanelMounted) return
    clearPreviewRequest()
  }, [clearPreviewRequest, standardRightPanelMounted])

  const selectMode = useCallback(
    (nextMode: ResourcePanelOverlayMode) => {
      setProtectedOnlyOpen(false)
      if (standardRightPanelMounted) {
        setOpen(false)
        setRightModule(nextMode)
        return
      }
      setMode(nextMode)
      setOpen(true)
    },
    [setRightModule, standardRightPanelMounted]
  )

  useEffect(() => {
    return onOpenResourcePanelOverlay(selectMode)
  }, [selectMode])

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
        protectedFunctionPreviewRequest={mode === "preview" ? protectedPreview : null}
        onProtectedFunctionPreviewClosed={clearProtectedPreview}
        onResourcePreviewRequestHandled={clearPreviewRequest}
        listenForResourcePreview={false}
        onRequestPreviewMode={() => setMode("preview")}
        onRequestWorkMode={close}
      />
    </OverlayDrawer>
  )
}
