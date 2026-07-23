import { useCallback, useEffect, useRef } from "react"

const HIDDEN_BROWSER_BOUNDS = { x: 0, y: 0, width: 0, height: 0 }

function getBrowserSessionId(threadId: string): string {
  return `thread-${threadId}`
}

function formatBrowserViewLifecycleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface UseBrowserViewLifecycleOptions {
  activeRightPanelThreadId: string | null
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
  activeRightPanelThreadId,
  currentThreadId,
  harnessSessionThreadId,
  mainView,
  rightModule,
  rightPanelCollapsed,
  isAgentFocusActive,
  selectBrowserModule,
  setRightPanelCollapsed
}: UseBrowserViewLifecycleOptions): void {
  const lastVisibleBrowserSessionIdRef = useRef<string | null>(null)
  const rendererUnloadBrowserCleanupSentRef = useRef(false)

  const activeBrowserSessionId = activeRightPanelThreadId
    ? getBrowserSessionId(activeRightPanelThreadId)
    : null
  const isBrowserPanelVisible =
    rightModule === "browser" &&
    !rightPanelCollapsed &&
    !isAgentFocusActive &&
    ((mainView === "thread" && Boolean(currentThreadId)) ||
      (mainView === "harness" && Boolean(harnessSessionThreadId)))

  const detachBrowserSession = useCallback((sessionId: string, reason: string) => {
    console.info(`[App] Detaching Browser session ${sessionId} because ${reason}.`)
    void window.api.browser.detach(sessionId).catch((error) => {
      console.error(
        `[App] Browser session ${sessionId} detach failed: ${formatBrowserViewLifecycleError(error)}.`
      )
    })
  }, [])

  const hideBrowserSession = useCallback((sessionId: string, reason: string) => {
    console.info(`[App] Hiding Browser session ${sessionId} because ${reason}.`)
    void window.api.browser.setBounds(sessionId, HIDDEN_BROWSER_BOUNDS, false).catch((error) => {
      console.error(
        `[App] Browser session ${sessionId} hide failed: ${formatBrowserViewLifecycleError(error)}.`
      )
    })
  }, [])

  useEffect(() => {
    console.info(
      `[App] Browser panel visibility snapshot: visible=${isBrowserPanelVisible} module=${rightModule} collapsed=${rightPanelCollapsed} agentFocus=${isAgentFocusActive} mainView=${mainView} currentThreadId=${currentThreadId ?? "(none)"} harnessThreadId=${harnessSessionThreadId ?? "(none)"} activeSession=${activeBrowserSessionId ?? "(none)"} lastVisibleSession=${lastVisibleBrowserSessionIdRef.current ?? "(none)"}.`
    )
  }, [
    activeBrowserSessionId,
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
        `[App] Renderer unload requested BrowserView cleanup; activeSession=${activeBrowserSessionId ?? "(none)"} browserPanelVisible=${isBrowserPanelVisible}.`
      )
      window.api.browser.disposeAllForRendererUnload()
    }

    window.addEventListener("beforeunload", handleRendererUnloadBrowserCleanup)
    window.addEventListener("pagehide", handleRendererUnloadBrowserCleanup)

    return () => {
      window.removeEventListener("beforeunload", handleRendererUnloadBrowserCleanup)
      window.removeEventListener("pagehide", handleRendererUnloadBrowserCleanup)
    }
  }, [activeBrowserSessionId, isBrowserPanelVisible])

  useEffect(() => {
    if (isBrowserPanelVisible && activeBrowserSessionId) {
      const previousSessionId = lastVisibleBrowserSessionIdRef.current
      console.info(
        `[App] Browser panel became visible; activeSession=${activeBrowserSessionId} previousVisibleSession=${previousSessionId ?? "(none)"}.`
      )
      if (previousSessionId && previousSessionId !== activeBrowserSessionId) {
        detachBrowserSession(previousSessionId, "the active thread changed")
      }
      lastVisibleBrowserSessionIdRef.current = activeBrowserSessionId
      return
    }

    const sessionId = lastVisibleBrowserSessionIdRef.current
    if (!sessionId) {
      console.info("[App] Browser panel hidden with no retained visible Browser session.")
      return
    }
    console.info(`[App] Browser panel no longer visible; last session=${sessionId}.`)
    lastVisibleBrowserSessionIdRef.current = null
    hideBrowserSession(sessionId, "the Browser panel is hidden")
  }, [activeBrowserSessionId, detachBrowserSession, hideBrowserSession, isBrowserPanelVisible])

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
