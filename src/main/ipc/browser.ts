import type { BrowserWindow, IpcMain } from "electron"
import {
  BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL,
  BUILTIN_BROWSER_LOG_PREFIX,
  type BrowserAttachOptions,
  type BrowserBounds,
  type BrowserCdpConfig,
  type BrowserNavigateOptions,
  type BrowserRecordingDraftUpdateInput,
  type BrowserRecordingSession,
  type BrowserScriptExecutionInput,
  type BrowserScriptLibraryDeleteInput,
  type BrowserScriptLibraryListOptions,
  type BrowserScriptLibraryReadInput,
  type BrowserScriptLibrarySaveInput,
  type BrowserScriptLibraryUpdateInput,
  type ScriptRecordingStartOptions
} from "../../shared/browser-types"
import {
  autoRegisterPlaywrightMcpConnector,
  syncPlaywrightMcpConnectorForBrowserCdpConfig
} from "../browser/cdp/browser-playwright-mcp-connector"
import { BrowserService } from "../browser/core/browser-service"
import { setGlobalBrowserService } from "../browser/core/browser-service-registry"
import { registerBrowserProfileImportHandlers } from "./browser-profile-import"
import {
  cancelRecordingScriptExecutionInBuiltinBrowser,
  executeRecordingScriptInBuiltinBrowser,
  getBrowserScriptExecutionState,
  isBrowserScriptExecutionCancelledError,
  onBrowserScriptExecutionStateChange
} from "../browser/record/common/browser-script-execution-service"
import {
  deleteBrowserScriptLibraryEntry,
  listBrowserScriptLibraryEntries,
  readBrowserScriptLibraryScript,
  saveBrowserScriptLibraryEntry,
  updateBrowserScriptLibraryEntry
} from "../browser/record/common/browser-script-library-service"
import {
  getScriptRecording,
  installScriptRecorderForSubtree,
  pauseScriptRecording,
  resumeScriptRecording,
  startScriptRecording,
  stopScriptRecording,
  updateScriptRecordingDraft
} from "../browser/record/script-record/script-recording-service"
import { invalidateGlobalMcpCapabilityService } from "../mcp/capability-service"
import { getBrowserCdpConfigAsync, saveBrowserCdpConfigAsync } from "../storage"

const BROWSER_SERVICE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserService]`

export type GetMainWindow = () => BrowserWindow | null

export interface BrowserIpcContext {
  browserService: BrowserService
  getMainWindow: GetMainWindow
  ipcMain: IpcMain
}

function registerBrowserStateForwarding(getMainWindow: GetMainWindow): void {
  void onBrowserScriptExecutionStateChange((state) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, state)
  })
}

function registerBrowserRendererLifecycleIpc({
  browserService,
  getMainWindow,
  ipcMain
}: BrowserIpcContext): void {
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
}

function registerBrowserControlIpc({ browserService, ipcMain }: BrowserIpcContext): void {
  ipcMain.handle("browser:attach", (_event, options?: BrowserAttachOptions) => {
    return browserService.attach(options)
  })

  ipcMain.handle("browser:detach", () => {
    return browserService.detach()
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
}

async function installScriptRecorderOnActiveBrowser(browserService: BrowserService): Promise<void> {
  const webContents = browserService.getWebContents()
  if (!webContents) return
  await installScriptRecorderForSubtree(webContents.mainFrame)
}

function registerBrowserScriptRecordingIpc({ browserService, ipcMain }: BrowserIpcContext): void {
  ipcMain.handle(
    "browser:startScriptRecording",
    async (_event, options?: ScriptRecordingStartOptions): Promise<BrowserRecordingSession> => {
      const session = startScriptRecording(options)
      await installScriptRecorderOnActiveBrowser(browserService)
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
    await installScriptRecorderOnActiveBrowser(browserService)
    return session
  })

  ipcMain.handle(
    "browser:stopScriptRecording",
    (): BrowserRecordingSession => stopScriptRecording()
  )

  ipcMain.handle("browser:getScriptRecording", (): BrowserRecordingSession => getScriptRecording())
}

function registerBrowserScriptLibraryIpc({ ipcMain }: Pick<BrowserIpcContext, "ipcMain">): void {
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
}

function registerBrowserScriptExecutionIpc({ ipcMain }: Pick<BrowserIpcContext, "ipcMain">): void {
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
}

function sanitizeBrowserCdpConfigUpdates(
  updates?: Partial<BrowserCdpConfig>
): Partial<BrowserCdpConfig> {
  const sanitized: Partial<BrowserCdpConfig> = {}
  if (updates && typeof updates.enabled === "boolean") {
    sanitized.enabled = updates.enabled
  }
  if (updates && typeof updates.profileImportEnabled === "boolean") {
    sanitized.profileImportEnabled = updates.profileImportEnabled
  }
  return sanitized
}

function registerBrowserCdpIpc({ ipcMain }: Pick<BrowserIpcContext, "ipcMain">): void {
  ipcMain.handle("browser:getCdpConfig", () => getBrowserCdpConfigAsync())

  ipcMain.handle(
    "browser:saveCdpConfig",
    async (_event, updates?: Partial<BrowserCdpConfig>): Promise<BrowserCdpConfig> => {
      const saved = await saveBrowserCdpConfigAsync(sanitizeBrowserCdpConfigUpdates(updates))
      const { invalidateCapabilities } = await syncPlaywrightMcpConnectorForBrowserCdpConfig(saved)
      if (invalidateCapabilities) {
        await invalidateGlobalMcpCapabilityService("browser:saveCdpConfig")
      }
      return saved
    }
  )
}

function registerBrowserCaptureIpc({ browserService, ipcMain }: BrowserIpcContext): void {
  ipcMain.handle("browser:captureScreenshot", () => browserService.captureScreenshot())
}

export function registerBrowserIpcHandlers(context: BrowserIpcContext): void {
  registerBrowserStateForwarding(context.getMainWindow)
  registerBrowserRendererLifecycleIpc(context)
  registerBrowserControlIpc(context)
  registerBrowserScriptRecordingIpc(context)
  registerBrowserScriptLibraryIpc(context)
  registerBrowserScriptExecutionIpc(context)
  registerBrowserCdpIpc(context)
  registerBrowserCaptureIpc(context)
}

export function registerBrowserHandlers(
  ipcMain: IpcMain,
  getMainWindow: GetMainWindow
): BrowserService {
  const browserService = new BrowserService(getMainWindow)
  setGlobalBrowserService(browserService)
  registerBrowserIpcHandlers({ browserService, getMainWindow, ipcMain })
  return browserService
}

export function registerBuiltinBrowserIpc(
  ipcMain: IpcMain,
  getMainWindow: GetMainWindow,
  browserCdpPort: number | null
): BrowserService {
  const browserService = registerBrowserHandlers(ipcMain, getMainWindow)
  registerBrowserProfileImportHandlers(ipcMain, getMainWindow, browserService)
  void autoRegisterPlaywrightMcpConnector(browserCdpPort).catch((err) =>
    console.error(
      `${BUILTIN_BROWSER_LOG_PREFIX}[Main] Failed to auto-register Playwright MCP connector:`,
      err
    )
  )
  return browserService
}
