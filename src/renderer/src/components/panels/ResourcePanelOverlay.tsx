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
  const handlePreviewRequest = useCallback(
    (request: { filePath: string; externalPreviewGrant?: string }): void => {
      setMode(
        /\.html?$/i.test(request.filePath) && !request.externalPreviewGrant
          ? "browser"
          : "preview"
      )
      setOpen(true)
    },
    []
  )
  const { request: previewRequest, clear: clearPreviewRequest } = useResourcePreviewRequest(
    activeThreadId,
    !standardRightPanelMounted,
    handlePreviewRequest
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
        onResourcePreviewRequestHandled={clearPreviewRequest}
        listenForResourcePreview={false}
        onRequestPreviewMode={() => setMode("preview")}
        onRequestBrowserMode={() => setMode("browser")}
        onRequestWorkMode={close}
      />
    </OverlayDrawer>
  )
}
