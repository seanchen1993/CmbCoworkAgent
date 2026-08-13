import type { BrowserWindow, IpcMain } from "electron"
import { BrowserService } from "../browser/core/browser-service"
import { syncPlaywrightMcpConnectorForBrowserCdpConfig } from "../browser/cdp/browser-playwright-mcp-connector"
import { setGlobalBrowserService } from "../browser/core/browser-service-registry"
import {
  getScriptRecording,
  installScriptRecorderForSubtree,
  pauseScriptRecording,
  resumeScriptRecording,
  startScriptRecording,
  stopScriptRecording,
  updateScriptRecordingDraft
} from "../browser/record/script-record/script-recording-service"
import {
  deleteBrowserScriptLibraryEntry,
  listBrowserScriptLibraryEntries,
  readBrowserScriptLibraryScript,
  saveBrowserScriptLibraryEntry,
  updateBrowserScriptLibraryEntry
} from "../browser/record/common/browser-script-library-service"
import {
  cancelRecordingScriptExecutionInBuiltinBrowser,
  executeRecordingScriptInBuiltinBrowser,
  getBrowserScriptExecutionState,
  isBrowserScriptExecutionCancelledError,
  onBrowserScriptExecutionStateChange
} from "../browser/record/common/browser-script-execution-service"
import type {
  BrowserRecordingDraftUpdateInput,
  BrowserScriptLibraryDeleteInput,
  BrowserScriptLibraryListOptions,
  BrowserScriptLibraryReadInput,
  BrowserScriptExecutionInput,
  BrowserScriptLibrarySaveInput,
  BrowserScriptLibraryUpdateInput
} from "../../shared/browser-types"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"
import { getBrowserCdpConfigAsync, saveBrowserCdpConfigAsync } from "../storage"
import {
  BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL,
  BUILTIN_BROWSER_LOG_PREFIX
} from "../../shared/browser-types"
import type {
  BrowserAttachOptions,
  BrowserRecordingSession,
  BrowserBounds,
  BrowserCdpConfig,
  ScriptRecordingStartOptions,
  BrowserNavigateOptions
} from "../../shared/browser-types"

const BROWSER_SERVICE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserService]`

export function registerBrowserHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): BrowserService {
  const browserService = new BrowserService(getMainWindow)
  setGlobalBrowserService(browserService)
  const disposeScriptExecutionStateForwarder = onBrowserScriptExecutionStateChange((state) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, state)
  })

  ipcMain.handle("browser:attach", (_event, options?: BrowserAttachOptions) => {
    return browserService.attach(options)
  })

  ipcMain.handle("browser:detach", () => {
    return browserService.detach()
  })

  ipcMain.on("browser:disposeAllForRendererUnload", (event) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      console.warn(
        `${BROWSER_SERVICE_LOG_PREFIX} Ignored renderer-unload cleanup from unknown sender ${event.sender.id}.`
      )
      return
    }

    const disposedSessionId = browserService.disposeAll()
    console.info(
      `${BROWSER_SERVICE_LOG_PREFIX} Renderer unload cleanup requested by sender ${event.sender.id}; disposed=${disposedSessionId ?? "(none)"}.`
    )
  })

  ipcMain.handle("browser:setBounds", (_event, bounds: BrowserBounds, visible?: boolean) => {
    return browserService.setBounds(bounds, visible)
  })

  ipcMain.handle(
    "browser:navigate",
    async (_event, url: string, options?: BrowserNavigateOptions) => {
      return browserService.navigate(url, options)
    }
  )

  ipcMain.handle("browser:goBack", () => browserService.goBack())

  ipcMain.handle("browser:goForward", () => browserService.goForward())

  ipcMain.handle("browser:reload", () => browserService.reload())

  ipcMain.handle("browser:stop", () => browserService.stop())

  ipcMain.handle("browser:clearConsole", () => browserService.clearConsole())

  ipcMain.handle("browser:getState", () => browserService.getState())

  ipcMain.handle("browser:getCdpConfig", () => getBrowserCdpConfigAsync())
  ipcMain.handle(
    "browser:startScriptRecording",
    async (_event, options?: ScriptRecordingStartOptions): Promise<BrowserRecordingSession> => {
      const session = startScriptRecording(options)
      const webContents = browserService.getWebContents()
      if (webContents) {
        await installScriptRecorderForSubtree(webContents.mainFrame)
      }
      return session
    }
  )

  ipcMain.handle(
    "browser:pauseScriptRecording",
    (): BrowserRecordingSession => pauseScriptRecording()
  )

  ipcMain.handle(
    "browser:updateScriptRecordingDraft",
    (_event, input: BrowserRecordingDraftUpdateInput): BrowserRecordingSession =>
      updateScriptRecordingDraft(input)
  )

  ipcMain.handle("browser:resumeScriptRecording", async (): Promise<BrowserRecordingSession> => {
    const session = resumeScriptRecording()
    const webContents = browserService.getWebContents()
    if (webContents) {
      await installScriptRecorderForSubtree(webContents.mainFrame)
    }
    return session
  })

  ipcMain.handle(
    "browser:stopScriptRecording",
    (): BrowserRecordingSession => stopScriptRecording()
  )

  ipcMain.handle("browser:getScriptRecording", (): BrowserRecordingSession => getScriptRecording())

  ipcMain.handle(
    "browser:saveScriptLibraryEntry",
    async (_event, input: BrowserScriptLibrarySaveInput) => {
      return saveBrowserScriptLibraryEntry(input)
    }
  )

  ipcMain.handle(
    "browser:listScriptLibraryEntries",
    async (_event, options?: BrowserScriptLibraryListOptions) => {
      return listBrowserScriptLibraryEntries(options)
    }
  )

  ipcMain.handle(
    "browser:readScriptLibraryScript",
    async (_event, input: BrowserScriptLibraryReadInput) => {
      return readBrowserScriptLibraryScript(input)
    }
  )

  ipcMain.handle(
    "browser:updateScriptLibraryEntry",
    async (_event, input: BrowserScriptLibraryUpdateInput) => {
      return updateBrowserScriptLibraryEntry(input)
    }
  )

  ipcMain.handle(
    "browser:deleteScriptLibraryEntry",
    async (_event, input: BrowserScriptLibraryDeleteInput) => {
      return deleteBrowserScriptLibraryEntry(input)
    }
  )

  ipcMain.handle(
    "browser:executeRecordingScript",
    async (_event, input: BrowserScriptExecutionInput): Promise<void> => {
      try {
        await executeRecordingScriptInBuiltinBrowser(input)
      } catch (error) {
        if (isBrowserScriptExecutionCancelledError(error)) return
        throw error
      }
    }
  )

  ipcMain.handle("browser:getScriptExecutionState", () => getBrowserScriptExecutionState())

  ipcMain.handle("browser:cancelRecordingScriptExecution", async () => {
    return cancelRecordingScriptExecutionInBuiltinBrowser()
  })

  ipcMain.handle(
    "browser:saveCdpConfig",
    async (_event, updates?: Partial<BrowserCdpConfig>): Promise<BrowserCdpConfig> => {
      const sanitized: Partial<BrowserCdpConfig> = {}
      if (updates && typeof updates.enabled === "boolean") {
        sanitized.enabled = updates.enabled
      }
      if (updates && typeof updates.profileImportEnabled === "boolean") {
        sanitized.profileImportEnabled = updates.profileImportEnabled
      }
      if (updates && updates.port !== undefined) {
        if (typeof updates.port !== "number" || !Number.isSafeInteger(updates.port)) {
          throw new Error("CDP 端口必须是 1 到 65535 之间的整数")
        }
        sanitized.port = updates.port
      }
      const saved = await saveBrowserCdpConfigAsync(sanitized)
      const { invalidateCapabilities } = await syncPlaywrightMcpConnectorForBrowserCdpConfig(saved)
      if (invalidateCapabilities) {
        await invalidateGlobalMcpCapabilityService("browser:saveCdpConfig")
      }
      return saved
    }
  )

  ipcMain.handle("browser:captureScreenshot", () => browserService.captureScreenshot())

  void disposeScriptExecutionStateForwarder
  return browserService
}
