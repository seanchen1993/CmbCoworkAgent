import { useCallback, useEffect, useRef } from "react"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  BROWSER_SESSION_ID
} from "../../../../shared/browser-types"
import { hasOpenModalDialog, MODAL_DIALOG_CHANGE_EVENT } from "@/lib/modal-dialog"
import { useAppStore } from "@/lib/store"

const HIDDEN_BROWSER_BOUNDS = { x: 0, y: 0, width: 0, height: 0 }
const BROWSER_APP_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[App]`

function formatBrowserViewLifecycleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface UseBrowserViewLifecycleOptions {
  currentThreadId: string | null
  harnessSessionThreadId: string | null
  mainView: string
  rightPanelCollapsed: boolean
  isAgentFocusActive: boolean
}

export function useBrowserViewLifecycle({
  currentThreadId,
  harnessSessionThreadId,
  mainView,
  rightPanelCollapsed,
  isAgentFocusActive
}: UseBrowserViewLifecycleOptions): void {
  const rightModule = useAppStore((state) => state.rightModule)
  const requestOpenBrowserPanel = useAppStore((state) => state.requestOpenBrowserPanel)
  const wasBrowserPanelVisibleRef = useRef(false)
  const rendererUnloadBrowserCleanupSentRef = useRef(false)
  const modalDialogOpenRef = useRef(false)

  const isBrowserPanelVisible =
    rightModule === "browser" &&
    !rightPanelCollapsed &&
    !isAgentFocusActive &&
    ((mainView === "thread" && Boolean(currentThreadId)) ||
      (mainView === "harness" && Boolean(harnessSessionThreadId)))

  const hideBrowserSession = useCallback((reason: string) => {
    console.info(`${BROWSER_APP_LOG_PREFIX} Hiding Browser session ${BROWSER_SESSION_ID} because ${reason}.`)
    void window.api.browser.setBounds(HIDDEN_BROWSER_BOUNDS, false).catch((error) => {
      console.error(
        `${BROWSER_APP_LOG_PREFIX} Browser session ${BROWSER_SESSION_ID} hide failed: ${formatBrowserViewLifecycleError(error)}.`
      )
    })
  }, [])

  useEffect(() => {
    console.info(
      `${BROWSER_APP_LOG_PREFIX} Browser panel visibility snapshot: visible=${isBrowserPanelVisible} module=${rightModule} collapsed=${rightPanelCollapsed} agentFocus=${isAgentFocusActive} mainView=${mainView} currentThreadId=${currentThreadId ?? "(none)"} harnessThreadId=${harnessSessionThreadId ?? "(none)"} session=${BROWSER_SESSION_ID}.`
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
        `${BROWSER_APP_LOG_PREFIX} Renderer unload requested BrowserView cleanup; session=${BROWSER_SESSION_ID} browserPanelVisible=${isBrowserPanelVisible}.`
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
      console.info(`${BROWSER_APP_LOG_PREFIX} Browser panel became visible; session=${BROWSER_SESSION_ID}.`)
      return
    }

    if (!wasBrowserPanelVisibleRef.current) {
      console.info(`${BROWSER_APP_LOG_PREFIX} Browser panel hidden with no visible Browser session to hide.`)
      return
    }
    wasBrowserPanelVisibleRef.current = false
    hideBrowserSession("the Browser panel is hidden")
  }, [hideBrowserSession, isBrowserPanelVisible])

  useEffect(() => {
    if (typeof MutationObserver === "undefined" || !document.body) return

    let frame: number | null = null
    const syncModalDialogState = (): void => {
      frame = null
      const modalDialogOpen = hasOpenModalDialog()
      if (modalDialogOpen === modalDialogOpenRef.current) return

      modalDialogOpenRef.current = modalDialogOpen
      window.dispatchEvent(new Event(MODAL_DIALOG_CHANGE_EVENT))
      console.info(
        `${BROWSER_APP_LOG_PREFIX} Modal dialog visibility changed: open=${modalDialogOpen}; session=${BROWSER_SESSION_ID}.`
      )
      if (modalDialogOpen && wasBrowserPanelVisibleRef.current) {
        hideBrowserSession("a modal dialog is open")
      }
    }

    const scheduleModalDialogStateSync = (): void => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(syncModalDialogState)
    }

    const observer = new MutationObserver(scheduleModalDialogStateSync)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "data-state", "role"]
    })
    scheduleModalDialogStateSync()

    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [hideBrowserSession])

  useEffect(() => {
    return window.api.browser.onPanelRequest((request) => {
      if (mainView !== "thread" && mainView !== "harness") return
      const requestedThreadId = request.threadId ?? null
      const activeThreadId = mainView === "harness" ? harnessSessionThreadId : currentThreadId
      if (requestedThreadId && activeThreadId && requestedThreadId !== activeThreadId) return
      if (requestedThreadId && !activeThreadId) return
      requestOpenBrowserPanel()
      console.info(
        `${BROWSER_APP_LOG_PREFIX} Showing Browser panel for ${requestedThreadId || activeThreadId || "active thread"}.`
      )
    })
  }, [
    currentThreadId,
    harnessSessionThreadId,
    mainView,
    requestOpenBrowserPanel
  ])
}
