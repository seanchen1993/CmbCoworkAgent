import { useCallback, useEffect, useRef } from "react"
import { BROWSER_SESSION_ID } from "../../../../shared/browser-types"

const HIDDEN_BROWSER_BOUNDS = { x: 0, y: 0, width: 0, height: 0 }

function formatBrowserViewLifecycleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface UseBrowserViewLifecycleOptions {
  currentThreadId: string | null
  harnessSessionThreadId: string | null
  mainView: string
  rightModule: string
  rightPanelCollapsed: boolean
  isAgentFocusActive: boolean
  selectBrowserModule: () => void
  setRightPanelCollapsed: (collapsed: boolean) => void
}

export function useBrowserViewLifecycle({
  currentThreadId,
  harnessSessionThreadId,
  mainView,
  rightModule,
  rightPanelCollapsed,
  isAgentFocusActive,
  selectBrowserModule,
  setRightPanelCollapsed
}: UseBrowserViewLifecycleOptions): void {
  const wasBrowserPanelVisibleRef = useRef(false)
  const rendererUnloadBrowserCleanupSentRef = useRef(false)

  const isBrowserPanelVisible =
    rightModule === "browser" &&
    !rightPanelCollapsed &&
    !isAgentFocusActive &&
    ((mainView === "thread" && Boolean(currentThreadId)) ||
      (mainView === "harness" && Boolean(harnessSessionThreadId)))

  const hideBrowserSession = useCallback((reason: string) => {
    console.info(`[App] Hiding Browser session ${BROWSER_SESSION_ID} because ${reason}.`)
    void window.api.browser.setBounds(HIDDEN_BROWSER_BOUNDS, false).catch((error) => {
      console.error(
        `[App] Browser session ${BROWSER_SESSION_ID} hide failed: ${formatBrowserViewLifecycleError(error)}.`
      )
    })
  }, [])

  useEffect(() => {
    console.info(
      `[App] Browser panel visibility snapshot: visible=${isBrowserPanelVisible} module=${rightModule} collapsed=${rightPanelCollapsed} agentFocus=${isAgentFocusActive} mainView=${mainView} currentThreadId=${currentThreadId ?? "(none)"} harnessThreadId=${harnessSessionThreadId ?? "(none)"} session=${BROWSER_SESSION_ID}.`
    )
  }, [
    currentThreadId,
    harnessSessionThreadId,
    isAgentFocusActive,
    isBrowserPanelVisible,
    mainView,
    rightModule,
    rightPanelCollapsed
  ])

  useEffect(() => {
    rendererUnloadBrowserCleanupSentRef.current = false

    const handleRendererUnloadBrowserCleanup = (): void => {
      if (rendererUnloadBrowserCleanupSentRef.current) return
      rendererUnloadBrowserCleanupSentRef.current = true
      console.info(
        `[App] Renderer unload requested BrowserView cleanup; session=${BROWSER_SESSION_ID} browserPanelVisible=${isBrowserPanelVisible}.`
      )
      window.api.browser.disposeAllForRendererUnload()
    }

    window.addEventListener("beforeunload", handleRendererUnloadBrowserCleanup)
    window.addEventListener("pagehide", handleRendererUnloadBrowserCleanup)

    return () => {
      window.removeEventListener("beforeunload", handleRendererUnloadBrowserCleanup)
      window.removeEventListener("pagehide", handleRendererUnloadBrowserCleanup)
    }
  }, [isBrowserPanelVisible])

  useEffect(() => {
    if (isBrowserPanelVisible) {
      wasBrowserPanelVisibleRef.current = true
      console.info(`[App] Browser panel became visible; session=${BROWSER_SESSION_ID}.`)
      return
    }

    if (!wasBrowserPanelVisibleRef.current) {
      console.info("[App] Browser panel hidden with no visible Browser session to hide.")
      return
    }
    wasBrowserPanelVisibleRef.current = false
    hideBrowserSession("the Browser panel is hidden")
  }, [hideBrowserSession, isBrowserPanelVisible])

  useEffect(() => {
    return window.api.browser.onPanelRequest((request) => {
      if (mainView !== "thread" && mainView !== "harness") return
      const requestedThreadId = request.threadId ?? null
      const activeThreadId = mainView === "harness" ? harnessSessionThreadId : currentThreadId
      if (requestedThreadId && activeThreadId && requestedThreadId !== activeThreadId) return
      if (requestedThreadId && !activeThreadId) return
      setRightPanelCollapsed(false)
      selectBrowserModule()
      console.info(
        `[App] Showing Browser panel for ${requestedThreadId || activeThreadId || "active thread"}.`
      )
    })
  }, [
    currentThreadId,
    harnessSessionThreadId,
    mainView,
    selectBrowserModule,
    setRightPanelCollapsed
  ])
}
