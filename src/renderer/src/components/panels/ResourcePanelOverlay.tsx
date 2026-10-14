import { useCallback, useEffect, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useAppStore } from "@/lib/store"
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
}

export function ResourcePanelOverlay({
  isAgentFocusActive,
  renderedMainView,
  renderedPanelThreadId
}: ResourcePanelOverlayProps): React.JSX.Element | null {
  const rightPanelCollapsed = useAppStore((state) => state.rightPanelCollapsed)
  const rightModule = useAppStore((state) => state.rightModule)
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

  useEffect(() => {
    // Only the drawer opened for this protected request follows its native lifetime.
    // Explicit preview/browser/git and ordinary file requests keep their original behavior.
    if (!protectedOnlyOpen || !open || mode !== "preview" || protectedPreview) return
    setOpen(false)
    setProtectedOnlyOpen(false)
  }, [protectedOnlyOpen, open, mode, protectedPreview])

  const close = useCallback(() => {
    setOpen(false)
    setProtectedOnlyOpen(false)
    clearPreviewRequest()
    clearProtectedPreview()
  }, [clearPreviewRequest, clearProtectedPreview])

  useEffect(() => {
    if (!standardRightPanelMounted) return
    setOpen(false)
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
