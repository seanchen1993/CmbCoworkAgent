import { ipcRenderer } from "electron"
import {
  BROWSER_DOWNLOADS_CHANGED_CHANNEL,
  BROWSER_PANEL_REQUEST_CHANNEL,
  BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL,
  BROWSER_SCRIPT_RECORDING_STATE_CHANNEL,
  BROWSER_SESSION_ID,
  type BrowserAttachOptions,
  type BrowserBounds,
  type BrowserCdpConfig,
  type BrowserDownloadsChangedPayload,
  type BrowserNavigateOptions,
  type BrowserPanelRequest,
  type BrowserProfileImportOptions,
  type BrowserProfileImportResult,
  type BrowserRecordingDraftUpdateInput,
  type BrowserRecordingSession,
  type BrowserScreenshotResult,
  type BrowserScriptExecutionInput,
  type BrowserScriptExecutionState,
  type BrowserScriptLibraryDeleteInput,
  type BrowserScriptLibraryEntry,
  type BrowserScriptLibraryListOptions,
  type BrowserScriptLibraryReadInput,
  type BrowserScriptLibrarySaveInput,
  type BrowserScriptLibraryUpdateInput,
  type BrowserState,
  type ScriptRecordingStartOptions
} from "../shared/browser-types"

export function createBrowserApi() {
  return {
    attach: (options?: BrowserAttachOptions) =>
      ipcRenderer.invoke("browser:attach", options) as Promise<BrowserState>,
    detach: () => ipcRenderer.invoke("browser:detach") as Promise<BrowserState>,
    setBounds: (bounds: BrowserBounds, visible?: boolean) =>
      ipcRenderer.invoke("browser:setBounds", bounds, visible) as Promise<BrowserState>,
    setZoomFactor: (zoomFactor: number) =>
      ipcRenderer.invoke("browser:setZoomFactor", zoomFactor) as Promise<BrowserState>,
    navigate: (url: string, options?: BrowserNavigateOptions) =>
      ipcRenderer.invoke("browser:navigate", url, options) as Promise<BrowserState>,
    goBack: () => ipcRenderer.invoke("browser:goBack") as Promise<BrowserState>,
    goForward: () => ipcRenderer.invoke("browser:goForward") as Promise<BrowserState>,
    reload: () => ipcRenderer.invoke("browser:reload") as Promise<BrowserState>,
    stop: () => ipcRenderer.invoke("browser:stop") as Promise<BrowserState>,
    clearConsole: () => ipcRenderer.invoke("browser:clearConsole") as Promise<BrowserState>,
    getState: () => ipcRenderer.invoke("browser:getState") as Promise<BrowserState>,
    getDownloads: () =>
      ipcRenderer.invoke("browser:getDownloads") as Promise<BrowserDownloadsChangedPayload>,
    markDownloadsRead: () =>
      ipcRenderer.invoke("browser:markDownloadsRead") as Promise<BrowserDownloadsChangedPayload>,
    restoreDownloads: (snapshot: BrowserDownloadsChangedPayload) =>
      ipcRenderer.invoke(
        "browser:restoreDownloads",
        snapshot
      ) as Promise<BrowserDownloadsChangedPayload>,
    getDownloadDirectory: () =>
      ipcRenderer.invoke("browser:getDownloadDirectory") as Promise<string>,
    openDownloadDirectory: () =>
      ipcRenderer.invoke("browser:openDownloadDirectory") as Promise<boolean>,
    showDownloadInFolder: (downloadId: string) =>
      ipcRenderer.invoke("browser:showDownloadInFolder", downloadId) as Promise<boolean>,
    startScriptRecording: (options?: ScriptRecordingStartOptions) =>
      ipcRenderer.invoke(
        "browser:startScriptRecording",
        options
      ) as Promise<BrowserRecordingSession>,
    pauseScriptRecording: (panelWidth?: number) =>
      ipcRenderer.invoke(
        "browser:pauseScriptRecording",
        panelWidth
      ) as Promise<BrowserRecordingSession>,
    updateScriptRecordingDraft: (input: BrowserRecordingDraftUpdateInput) =>
      ipcRenderer.invoke(
        "browser:updateScriptRecordingDraft",
        input
      ) as Promise<BrowserRecordingSession>,
    resumeScriptRecording: () =>
      ipcRenderer.invoke("browser:resumeScriptRecording") as Promise<BrowserRecordingSession>,
    stopScriptRecording: (panelWidth?: number) =>
      ipcRenderer.invoke(
        "browser:stopScriptRecording",
        panelWidth
      ) as Promise<BrowserRecordingSession>,
    getScriptRecording: () =>
      ipcRenderer.invoke("browser:getScriptRecording") as Promise<BrowserRecordingSession>,
    saveScriptLibraryEntry: (input: BrowserScriptLibrarySaveInput) =>
      ipcRenderer.invoke(
        "browser:saveScriptLibraryEntry",
        input
      ) as Promise<BrowserScriptLibraryEntry>,
    listScriptLibraryEntries: (options?: BrowserScriptLibraryListOptions) =>
      ipcRenderer.invoke("browser:listScriptLibraryEntries", options) as Promise<
        BrowserScriptLibraryEntry[]
      >,
    readScriptLibraryScript: (input: BrowserScriptLibraryReadInput) =>
      ipcRenderer.invoke("browser:readScriptLibraryScript", input) as Promise<string>,
    updateScriptLibraryEntry: (input: BrowserScriptLibraryUpdateInput) =>
      ipcRenderer.invoke("browser:updateScriptLibraryEntry", input) as Promise<void>,
    deleteScriptLibraryEntry: (input: BrowserScriptLibraryDeleteInput) =>
      ipcRenderer.invoke("browser:deleteScriptLibraryEntry", input) as Promise<void>,
    executeRecordingScript: (input: BrowserScriptExecutionInput) =>
      ipcRenderer.invoke("browser:executeRecordingScript", input) as Promise<void>,
    getScriptExecutionState: () =>
      ipcRenderer.invoke("browser:getScriptExecutionState") as Promise<BrowserScriptExecutionState>,
    cancelRecordingScriptExecution: () =>
      ipcRenderer.invoke("browser:cancelRecordingScriptExecution") as Promise<boolean>,
    getCdpConfig: () => ipcRenderer.invoke("browser:getCdpConfig") as Promise<BrowserCdpConfig>,
    isProfileImportRuntimeEnabled: () =>
      ipcRenderer.invoke("browser:isProfileImportRuntimeEnabled") as Promise<boolean>,
    saveCdpConfig: (updates: Partial<BrowserCdpConfig>) =>
      ipcRenderer.invoke("browser:saveCdpConfig", updates) as Promise<BrowserCdpConfig>,
    captureScreenshot: () =>
      ipcRenderer.invoke("browser:captureScreenshot") as Promise<BrowserScreenshotResult>,
    importProfileData: (options: BrowserProfileImportOptions) =>
      ipcRenderer.invoke(
        "browser:importProfileData",
        options
      ) as Promise<BrowserProfileImportResult>,
    disposeAllForRendererUnload: () => ipcRenderer.send("browser:disposeAllForRendererUnload"),
    onState: (callback: (state: BrowserState) => void) => {
      const channel = `browser:state:${BROWSER_SESSION_ID}`
      const handler = (_: unknown, state: BrowserState): void => callback(state)
      ipcRenderer.on(channel, handler)
      return () => {
        ipcRenderer.removeListener(channel, handler)
      }
    },
    onDownloadsChanged: (callback: (payload: BrowserDownloadsChangedPayload) => void) => {
      const handler = (_: unknown, payload: BrowserDownloadsChangedPayload): void =>
        callback(payload)
      ipcRenderer.on(BROWSER_DOWNLOADS_CHANGED_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_DOWNLOADS_CHANGED_CHANNEL, handler)
      }
    },
    onPanelRequest: (callback: (request: BrowserPanelRequest) => void) => {
      const handler = (_: unknown, request: BrowserPanelRequest): void => callback(request)
      ipcRenderer.on(BROWSER_PANEL_REQUEST_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_PANEL_REQUEST_CHANNEL, handler)
      }
    },
    onScriptExecutionState: (callback: (state: BrowserScriptExecutionState) => void) => {
      const handler = (_: unknown, state: BrowserScriptExecutionState): void => callback(state)
      ipcRenderer.on(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_SCRIPT_EXECUTION_STATE_CHANNEL, handler)
      }
    },
    onScriptRecordingState: (callback: (state: BrowserRecordingSession) => void) => {
      const handler = (_: unknown, state: BrowserRecordingSession): void => callback(state)
      ipcRenderer.on(BROWSER_SCRIPT_RECORDING_STATE_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(BROWSER_SCRIPT_RECORDING_STATE_CHANNEL, handler)
      }
    }
  }
}

export type BrowserApi = ReturnType<typeof createBrowserApi>
