import { useCallback, useEffect, useRef, useState } from "react"
import { RightPanel } from "@/components/panels/RightPanel"
import { OverlayDrawer } from "@/components/panels/OverlayDrawer"
import { useBrowserViewLifecycle } from "@/components/browser/useBrowserViewLifecycle"
import { useBtwChat } from "@/lib/btw-chat"
import { useAppStore } from "@/lib/store"
import {
  onOpenResourcePanelOverlay,
  type ResourcePanelOverlayMode
} from "@/lib/resource-panel-overlay-events"
import { useResourcePreviewRequest } from "@/lib/use-resource-preview-request"
import type { OpenResourcePreviewDetail } from "@/lib/resource-preview-events"

interface ResourcePanelOverlayProps {
  isAgentFocusActive: boolean
  renderedMainView: string
  renderedPanelThreadId: string | null
  btwPaneVisible?: boolean
}

export function ResourcePanelOverlay({
  isAgentFocusActive,
  renderedMainView,
  renderedPanelThreadId,
  btwPaneVisible = false
}: ResourcePanelOverlayProps): React.JSX.Element | null {
  const rightPanelCollapsed = useAppStore((state) => state.rightPanelCollapsed)
  const setRightModule = useAppStore((state) => state.setRightModule)
  const activeThreadId = renderedPanelThreadId
  const btwThreadId = useBtwChat(state => {
    if (!btwPaneVisible || !activeThreadId) return null
    const selected = state.selected[activeThreadId]
    return state.tabs.find(tab => tab.id === selected && tab.parentId === activeThreadId && !tab.closeState)?.id ?? null
  })
  const standardRightPanelMounted =
    !isAgentFocusActive &&
    !rightPanelCollapsed &&
    (renderedMainView === "thread" || renderedMainView === "harness") &&
    Boolean(renderedPanelThreadId)
  const usePreviewDrawer = !standardRightPanelMounted || btwPaneVisible
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ResourcePanelOverlayMode>("preview")
  const [drawerOwner, setDrawerOwner] = useState<string | null>(null)
  const latestPreviewIntent = useRef(0)
  const handlePreviewRequest = useCallback((request: OpenResourcePreviewDetail): void => {
    if (request.intentId <= latestPreviewIntent.current) return
    latestPreviewIntent.current = request.intentId
    setDrawerOwner(request.threadId)
    setMode("preview")
    setOpen(true)
  }, [])
  const parentPreview = useResourcePreviewRequest(
    activeThreadId,
    usePreviewDrawer,
    handlePreviewRequest
  )
  const sidePreview = useResourcePreviewRequest(btwThreadId, btwPaneVisible, handlePreviewRequest)
  const drawerFromSide = btwPaneVisible && drawerOwner !== null && drawerOwner === btwThreadId
  const drawerInScope = drawerOwner === null || drawerOwner === activeThreadId || drawerFromSide
  const drawerVisible = open && drawerInScope
  const overlayThreadId = drawerFromSide ? btwThreadId : activeThreadId
  const preview = drawerFromSide ? sidePreview : parentPreview

  const close = useCallback(() => {
    setOpen(false)
    setDrawerOwner(null)
    parentPreview.clear()
    sidePreview.clear()
  }, [parentPreview.clear, sidePreview.clear])

  useEffect(() => {
    if (!usePreviewDrawer || !drawerInScope) close()
  }, [close, drawerInScope, usePreviewDrawer])

  const selectMode = useCallback(
    (nextMode: ResourcePanelOverlayMode) => {
      if (standardRightPanelMounted && !(btwPaneVisible && nextMode === "preview")) {
        close()
        setRightModule(nextMode)
        return
      }
      setDrawerOwner(null)
      setMode(nextMode)
      setOpen(true)
    },
    [btwPaneVisible, close, setRightModule, standardRightPanelMounted]
  )

  useEffect(() => {
    return onOpenResourcePanelOverlay(selectMode)
  }, [selectMode])

  const handleBrowserPanelRequest = useCallback((threadId: string | null) => {
    if (!btwPaneVisible) {
      selectMode("browser")
      return
    }
    // Automatic parent requests must leave the foreground side pane in place.
    if (!threadId || threadId !== btwThreadId) return
    setDrawerOwner(threadId)
    setMode("browser")
    setOpen(true)
  }, [btwPaneVisible, btwThreadId, selectMode])

  useBrowserViewLifecycle({
    currentThreadId: renderedMainView === "thread" ? activeThreadId : null,
    harnessSessionThreadId: renderedMainView === "harness" ? activeThreadId : null,
    visibleBtwThreadId: btwPaneVisible ? btwThreadId : null,
    mainView: renderedMainView,
    rightPanelCollapsed,
    isAgentFocusActive,
    overlayModule: drawerVisible ? mode : null,
    overlayThreadId,
    onRequestBrowserPanel: handleBrowserPanelRequest
  })

  if (!overlayThreadId || !usePreviewDrawer) return null

  return (
    <OverlayDrawer
      open={drawerVisible}
      title={mode === "git" ? "Git 面板" : mode === "browser" ? "内置浏览器" : "文件预览"}
      onClose={close}
    >
      {(mode !== "browser" || drawerVisible) && (
        <RightPanel
          threadId={overlayThreadId}
          moduleMode={mode}
          showSystemConstraints={renderedMainView === "harness"}
          resourcePreviewRequest={mode === "preview" || mode === "browser" ? preview.request : null}
          onResourcePreviewRequestHandled={preview.clear}
          listenForResourcePreview={false}
          observeCompletedResources={!(btwPaneVisible && standardRightPanelMounted && overlayThreadId === activeThreadId)}
          onRequestPreviewMode={() => setMode("preview")}
          onRequestWorkMode={close}
        />
      )}
    </OverlayDrawer>
  )
}
