import { stopBrowserProfileImportRuntime } from "../ipc/browser-profile-import"
import type { BrowserService } from "./core/browser-service"
import { setGlobalBrowserService } from "./core/browser-service-registry"

interface DisposeBuiltinBrowserForMainWindowEventOptions {
  browserService: BrowserService | null
  isAppQuitting: boolean
  reason: string
}

export function disposeBuiltinBrowserForMainWindowEvent({
  browserService,
  isAppQuitting,
  reason
}: DisposeBuiltinBrowserForMainWindowEventOptions): void {
  if (isAppQuitting) {
    void reason
    return
  }

  void reason
  browserService?.disposeAll()
}

export function beginBuiltinBrowserAppQuitCleanup(
  browserService: BrowserService | null
): () => void {
  setGlobalBrowserService(null)
  stopBrowserProfileImportRuntime()
  return () => {
    browserService?.disposeAll()
  }
}
