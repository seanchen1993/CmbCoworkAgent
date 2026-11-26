import { stopBrowserProfileImportRuntime } from "../ipc/browser-profile-import"
import type { BrowserService } from "./core/browser-service"
import { setGlobalBrowserService } from "./core/browser-service-registry"
import { disposeSharedBrowserScriptExecutionConnection } from "./record/common/browser-script-execution-service"

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
  void disposeSharedBrowserScriptExecutionConnection()
  browserService?.disposeAll()
}

export function beginBuiltinBrowserAppQuitCleanup(
  browserService: BrowserService | null
): () => Promise<void> {
  setGlobalBrowserService(null)
  stopBrowserProfileImportRuntime()
  return async () => {
    await disposeSharedBrowserScriptExecutionConnection()
    browserService?.disposeAll()
  }
}
