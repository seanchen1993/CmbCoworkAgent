import { useCallback, useEffect, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { BROWSER_PANEL_RESTORE_WIDTH_EVENT } from "@/components/panels/useRightPanelLayout"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useAppStore } from "@/lib/store"
import { getBrowserPageConfirmation } from "@/lib/browser-page-confirmation"
import {
  onOpenResourcePanelOverlay,
  onCloseResourcePanelOverlay,
  onDestroyOpenBrowserResourcePanel,
  type ResourcePanelInlinePreview,
  type ResourcePanelOverlayMode
} from "@/lib/resource-panel-overlay-events"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"
import {
  createOpenResourcePreviewDetail,
  emitOpenResourcePreview,
  type OpenResourcePreviewDetail,
  type OpenResourcePreviewRequest
} from "@/lib/resource-preview-events"

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
  const [filePreview, setFilePreview] = useState<OpenResourcePreviewDetail | null>(null)
  const [filePreviewThreadId, setFilePreviewThreadId] = useState<string | null>(null)
  const handlePreviewRequest = useCallback((): void => {
    setMode("preview")
    setBrowserUrl(null)
    setInlinePreview(null)
    setFilePreview(null)
    setFilePreviewThreadId(null)
    setOpen(true)
  }, [])
  const { request: previewRequest, clear: clearPreviewRequest } = useResourcePreviewRequest(
    activeThreadId,
    !standardRightPanelMounted,
    handlePreviewRequest
  )
  const overlayThreadId = filePreviewThreadId ?? renderedPanelThreadId

  const detachBrowser = useCallback(() => {
    if (mode !== "browser") return
    void window.api.browser.detach().catch((error) => {
      console.error("[ResourcePanelOverlay] Failed to detach Browser panel:", error)
    })
  }, [mode])
  const close = useCallback(() => {
    setOpen(false)
    setFilePreview(null)
    setFilePreviewThreadId(null)
    clearPreviewRequest()
    detachBrowser()
  }, [clearPreviewRequest, detachBrowser])
  const closeFromUser = useCallback(() => {
    if (mode === "browser") getBrowserPageConfirmation()?.onCancel()
    close()
  }, [close, mode])
  const clearHandledPreviewRequest = useCallback(() => {
    // Keep an explicitly supplied overlay preview alive for the lifetime of the
    // drawer. RightPanel stores the selected path locally after handling the
    // request, but clearing the parent request here can race with mounting the
    // panel for a different thread (notably from the requirement design page),
    // leaving an open drawer with its empty preview state.
    clearPreviewRequest()
  }, [clearPreviewRequest])

  useEffect(
    () =>
      onCloseResourcePanelOverlay((requestedMode) => {
        if (!requestedMode || requestedMode === mode) close()
      }),
    [close, mode]
  )

  useEffect(
    () =>
      window.api.browser.onPanelCloseRequest(() => {
        if (open && mode === "browser") close()
      }),
    [close, mode, open]
  )

  useEffect(
    () =>
      onDestroyOpenBrowserResourcePanel(() => {
        if (!open || mode !== "browser") return
        getBrowserPageConfirmation()?.onCancel()
        setOpen(false)
        setBrowserUrl(null)
        setInlinePreview(null)
        setFilePreview(null)
        setFilePreviewThreadId(null)
        clearPreviewRequest()
        detachBrowser()
      }),
    [clearPreviewRequest, detachBrowser, mode, open]
  )

  useEffect(() => {
    if (!standardRightPanelMounted) return
    close()
  }, [close, standardRightPanelMounted])

  const selectMode = useCallback(
    (
      nextMode: ResourcePanelOverlayMode,
      options?: {
        browserUrl?: string
        inlinePreview?: ResourcePanelInlinePreview
        filePreview?: OpenResourcePreviewRequest
      }
    ) => {
      if (standardRightPanelMounted) {
        if (mode === "browser") detachBrowser()
        setOpen(false)
        setRightModule(nextMode)
        if (options?.filePreview) emitOpenResourcePreview(options.filePreview)
        return
      }
      if (mode === "browser" && nextMode !== "browser") detachBrowser()
      setMode(nextMode)
      setBrowserUrl(options?.browserUrl ?? null)
      setInlinePreview(options?.inlinePreview ?? null)
      const nextFilePreview = options?.filePreview
        ? createOpenResourcePreviewDetail(options.filePreview)
        : null
      setFilePreview(nextFilePreview)
      setFilePreviewThreadId(nextFilePreview?.threadId ?? null)
      setOpen(true)
    },
    [detachBrowser, mode, setRightModule, standardRightPanelMounted]
  )

  useEffect(() => {
    return onOpenResourcePanelOverlay((detail) =>
      selectMode(detail.mode, {
        browserUrl: detail.browserUrl,
        inlinePreview: detail.inlinePreview,
        filePreview: detail.filePreview
      })
    )
  }, [selectMode])

  const handleBrowserPanelRequest = useCallback(() => {
    selectMode("browser")
  }, [selectMode])

  const handlePreviewModeRequest = useCallback(() => {
    // A file request has already selected preview mode and supplied the
    // thread/path context. Running selectMode("preview") again would clear
    // that context and make RightPanel reset the path it just accepted.
    if (mode === "preview") return
    selectMode("preview")
  }, [mode, selectMode])

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
      onClose={closeFromUser}
      defaultWidth={mode === "browser" ? "55%" : 720}
      widthRestoreEvent={mode === "browser" ? BROWSER_PANEL_RESTORE_WIDTH_EVENT : undefined}
    >
      <RightPanel
        threadId={overlayThreadId}
        moduleMode={mode}
        showSystemConstraints={renderedMainView === "harness"}
        browserInitialUrl={mode === "browser" ? browserUrl : null}
        inlinePreview={mode === "preview" ? inlinePreview : null}
        resourcePreviewRequest={
          mode === "preview" || mode === "browser" ? (filePreview ?? previewRequest) : null
        }
        onResourcePreviewRequestHandled={clearHandledPreviewRequest}
        listenForResourcePreview={false}
        onRequestPreviewMode={handlePreviewModeRequest}
        onRequestWorkMode={closeFromUser}
      />
    </OverlayDrawer>
  )
}
