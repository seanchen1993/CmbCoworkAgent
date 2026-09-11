import { useCallback, useEffect, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useAppStore } from "@/lib/store"
import {
  onOpenResourcePanelOverlay,
  type ResourcePanelInlinePreview,
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
  const [browserUrl, setBrowserUrl] = useState<string | null>(null)
  const [inlinePreview, setInlinePreview] = useState<ResourcePanelInlinePreview | null>(null)
  const handlePreviewRequest = useCallback((): void => {
    setMode("preview")
    setBrowserUrl(null)
    setInlinePreview(null)
    setOpen(true)
  }, [])
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
    (
      nextMode: ResourcePanelOverlayMode,
      options?: { browserUrl?: string; inlinePreview?: ResourcePanelInlinePreview }
    ) => {
      if (standardRightPanelMounted) {
        setRightModule(nextMode)
        return
      }
      setMode(nextMode)
      setBrowserUrl(options?.browserUrl ?? null)
      setInlinePreview(options?.inlinePreview ?? null)
      setOpen(true)
    },
    [setRightModule, standardRightPanelMounted]
  )

  useEffect(() => {
    return onOpenResourcePanelOverlay((detail) =>
      selectMode(detail.mode, {
        browserUrl: detail.browserUrl,
        inlinePreview: detail.inlinePreview
      })
    )
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

  // The overlay is the panel surface for non-thread views (e.g. the design
  // creation page). It must stay available even when no task thread is active,
  // so it only defers to the mounted standard right panel.
  if (standardRightPanelMounted) return null

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
        browserInitialUrl={mode === "browser" ? browserUrl : null}
        inlinePreview={mode === "preview" ? inlinePreview : null}
        resourcePreviewRequest={mode === "preview" || mode === "browser" ? previewRequest : null}
        onResourcePreviewRequestHandled={clearPreviewRequest}
        listenForResourcePreview={false}
        onRequestPreviewMode={() => setMode("preview")}
        onRequestWorkMode={close}
      />
    </OverlayDrawer>
  )
}
