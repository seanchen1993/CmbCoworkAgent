import { BUILTIN_BROWSER_LOG_PREFIX } from "../../shared/browser-types"
import { stopBrowserProfileImportRuntime } from "../ipc/browser-profile-import"
import type { BrowserService } from "./core/browser-service"
import { setGlobalBrowserService } from "./core/browser-service-registry"

const DEFAULT_BROWSER_MAIN_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[Main]`

interface DisposeBuiltinBrowserForMainWindowEventOptions {
  browserService: BrowserService | null
  isAppQuitting: boolean
  reason: string
  logPrefix?: string
}

export function disposeBuiltinBrowserForMainWindowEvent({
  browserService,
  isAppQuitting,
  reason,
  logPrefix = DEFAULT_BROWSER_MAIN_LOG_PREFIX
}: DisposeBuiltinBrowserForMainWindowEventOptions): void {
  if (isAppQuitting) {
    console.info(
      `${logPrefix} Deferred BrowserView disposal because the app is quitting; reason=${reason}.`
    )
    return
  }

  const disposedSessionId = browserService?.disposeAll() ?? null
  if (disposedSessionId) {
    console.info(
      `${logPrefix} Disposed BrowserView session ${disposedSessionId} because ${reason}.`
    )
  }
}

export function beginBuiltinBrowserAppQuitCleanup(
  browserService: BrowserService | null,
  logPrefix = DEFAULT_BROWSER_MAIN_LOG_PREFIX
): () => void {
  setGlobalBrowserService(null)
  stopBrowserProfileImportRuntime()
  return () => {
    const disposedSessionId = browserService?.disposeAll() ?? null
    if (disposedSessionId) {
      console.info(
        `${logPrefix} Disposed BrowserView session ${disposedSessionId} after MCP/runtime cleanup.`
      )
    }
  }
}
