import { BrowserWindow, IpcMain, dialog } from "electron"
import { createWriteStream, mkdtempSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import { getLspConfig, saveLspConfig, resetLspConfig } from "../storage"
import { importUserVsix, importUserVsixBuffer, getVsixDownloadTarget } from "../lsp/server"
import { invalidateJavaRuntimeCache } from "../lsp/runtimes"
import {
  startLsp,
  stopLsp,
  stopAllLsp,
  isLspRunning,
  getLspStatus,
  lspDefinition,
  lspReferences,
  lspHover,
  lspImplementation,
  lspDocumentSymbols,
  lspWorkspaceSymbol,
  lspDiagnostics,
  lspPrepareCallHierarchy,
  lspIncomingCalls,
  lspOutgoingCalls,
  detectJavaProject
} from "../lsp"
import type { LspConfig } from "../types"

const RESTART_RELEVANT_CONFIG_KEYS: Array<keyof LspConfig> = ["enabled", "maxHeapMb", "manualJavaHome"]

interface LspDownloadProgress {
  percent: number
  transferred: number
  total: number
}

interface LspDownloadState {
  isDownloading: boolean
  progress: LspDownloadProgress | null
}

let currentDownloadState: LspDownloadState = {
  isDownloading: false,
  progress: null
}

let activeVsixDownload: Promise<{ success: boolean; path?: string; error?: string }> | null = null

function getMarketplaceApiBaseUrl(): string {
  const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim().replace(/\/+$/, "")
  if (!baseUrl) {
    throw new Error("VITE_API_BASE_URL 未配置，无法下载 Java LSP 运行时")
  }
  return `${baseUrl}/api/trajectories/marketplace`
}

function getMarketplaceDownloadUrl(resourceType: string, name: string): string {
  return `${getMarketplaceApiBaseUrl()}/download/${encodeURIComponent(resourceType)}/${encodeURIComponent(name)}`
}

function getContentDispositionFilename(header: string | null, fallback: string): string {
  const encodedMatch = header?.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1].replace(/^"|"$/g, ""))
    } catch {
      return fallback
    }
  }
  const quotedMatch = header?.match(/filename="([^"]+)"/i)
  if (quotedMatch?.[1]) return quotedMatch[1]
  const plainMatch = header?.match(/filename=([^;]+)/i)
  return plainMatch?.[1]?.trim() || fallback
}

function getSafeTempFilename(fileName: string): string {
  return (basename(fileName).replace(/[\\/]/g, "_").trim() || "java-lsp.vsix")
}

function cleanupStaleVsixTempDirs(): void {
  const tempRoot = tmpdir()
  for (const entry of readdirSync(tempRoot)) {
    if (!entry.startsWith("cmb-lsp-vsix-")) continue
    try {
      rmSync(join(tempRoot, entry), { recursive: true, force: true })
    } catch {
      // Ignore stale temp cleanup failures; a fresh temp dir is still created below.
    }
  }
}

async function downloadLspVsixToTempFileWithProgress(
  name: string,
  onProgress: (progress: LspDownloadProgress) => void
): Promise<{ tempDir: string; filePath: string; fileName: string }> {
  const response = await fetch(getMarketplaceDownloadUrl("lsp", name), {
    method: "GET",
    headers: {
      Authorization: "Bearer your-api-token"
    }
  })

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`)
  }
  if (!response.body) {
    throw new Error("LSP VSIX download response body is empty")
  }

  const fileName = getContentDispositionFilename(response.headers.get("Content-Disposition"), `${name}.vsix`)
  cleanupStaleVsixTempDirs()
  const tempDir = mkdtempSync(join(tmpdir(), "cmb-lsp-vsix-"))
  const filePath = join(tempDir, getSafeTempFilename(fileName))
  const total = Number(response.headers.get("Content-Length") ?? 0)
  const reader = response.body.getReader()
  const writer = createWriteStream(filePath)
  let transferred = 0

  onProgress({ percent: 0, transferred: 0, total })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      transferred += value.byteLength
      if (!writer.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => {
          writer.once("drain", () => resolve())
        })
      }

      const percent = total > 0
        ? Math.min(100, Math.round((transferred / total) * 100))
        : 0

      onProgress({ percent, transferred, total })
    }

    writer.end()
    await new Promise<void>((resolve) => {
      writer.once("finish", () => resolve())
    })
  } catch (error) {
    writer.destroy()
    rmSync(tempDir, { recursive: true, force: true })
    throw error
  } finally {
    reader.releaseLock()
  }

  onProgress({
    percent: 100,
    transferred,
    total: total > 0 ? total : transferred
  })

  return { tempDir, filePath, fileName }
}

function notifyChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:changed")
  }
}

function notifyDownloadState(state: LspDownloadState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("lsp:download-state", state)
  }
}

function setDownloadState(state: LspDownloadState): void {
  currentDownloadState = state
  notifyDownloadState(state)
}

export function registerLspHandlers(ipcMain: IpcMain): void {
  console.log("[LSP] Registering LSP handlers...")

  ipcMain.handle("lsp:getConfig", async (): Promise<LspConfig> => {
    return getLspConfig()
  })

  ipcMain.handle(
    "lsp:saveConfig",
    async (_event, updates: Partial<LspConfig>): Promise<void> => {
      const current = getLspConfig()
      const shouldStopServers = RESTART_RELEVANT_CONFIG_KEYS.some((key) => (
        Object.prototype.hasOwnProperty.call(updates, key) && updates[key] !== current[key]
      ))
      saveLspConfig(updates)
      if (Object.prototype.hasOwnProperty.call(updates, "manualJavaHome")) {
        invalidateJavaRuntimeCache()
      }
      if (shouldStopServers) {
        await stopAllLsp()
      }
      notifyChanged()
    }
  )

  ipcMain.handle("lsp:resetConfig", async (): Promise<LspConfig> => {
    const defaults = resetLspConfig()
    invalidateJavaRuntimeCache()
    if (!defaults.enabled) {
      await stopAllLsp()
    }
    notifyChanged()
    return defaults
  })

  ipcMain.handle(
    "lsp:start",
    async (_event, projectRoot: string): Promise<void> => {
      await startLsp(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:stop",
    async (_event, projectRoot: string): Promise<void> => {
      await stopLsp(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:isRunning",
    async (_event, projectRoot: string): Promise<boolean> => {
      return isLspRunning(projectRoot)
    }
  )

  ipcMain.handle(
    "lsp:getStatus",
    async (_event, projectRoot: string | null) => {
      return getLspStatus(projectRoot)
    }
  )

  ipcMain.handle("lsp:getDownloadTarget", async (): Promise<{ name: string; filenames: string[] }> => {
    return getVsixDownloadTarget()
  })

  ipcMain.handle("lsp:getDownloadState", async (): Promise<LspDownloadState> => {
    return currentDownloadState
  })

  ipcMain.handle("lsp:downloadVsix", async (): Promise<{ success: boolean; path?: string; error?: string }> => {
    if (activeVsixDownload) {
      return activeVsixDownload
    }

    setDownloadState({ isDownloading: true, progress: { percent: 0, transferred: 0, total: 0 } })

    activeVsixDownload = (async (): Promise<{ success: boolean; path?: string; error?: string }> => {
      let tempDir: string | null = null
      try {
        const target = getVsixDownloadTarget()
        const downloaded = await downloadLspVsixToTempFileWithProgress(target.name, (progress) => {
          setDownloadState({ isDownloading: true, progress })
        })
        tempDir = downloaded.tempDir
        const imported = importUserVsix(downloaded.filePath, downloaded.fileName)
        saveLspConfig({ lastError: null })
        notifyChanged()
        return { success: true, path: imported.path }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      } finally {
        if (tempDir) rmSync(tempDir, { recursive: true, force: true })
        activeVsixDownload = null
        setDownloadState({ isDownloading: false, progress: null })
      }
    })()

    return activeVsixDownload
  })

  ipcMain.handle("lsp:importVsix", async (): Promise<{ success: boolean; path?: string; error?: string }> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "选择 Java LSP VSIX 文件",
      message: "导入当前平台的 Java 扩展 .vsix 文件",
      filters: [{ name: "VSIX Files", extensions: ["vsix"] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: "已取消导入" }
    }

    try {
      const imported = importUserVsix(result.filePaths[0])
      saveLspConfig({ lastError: null })
      notifyChanged()
      return { success: true, path: imported.path }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(
    "lsp:saveDownloadedVsix",
    async (_event, payload: { buffer: ArrayBuffer; fileName?: string }): Promise<{ success: boolean; path?: string; error?: string }> => {
      const { buffer, fileName } = payload || {}
      if (!buffer) {
        return { success: false, error: "Invalid VSIX buffer" }
      }

      try {
        const imported = importUserVsixBuffer(buffer, fileName)
        saveLspConfig({ lastError: null })
        notifyChanged()
        return { success: true, path: imported.path }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  ipcMain.handle(
    "lsp:definition",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspDefinition(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:references",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspReferences(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:hover",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspHover(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:implementation",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspImplementation(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:documentSymbols",
    async (_event, params: { projectRoot: string; filePath: string }) => {
      return lspDocumentSymbols(params.projectRoot, params.filePath)
    }
  )

  ipcMain.handle(
    "lsp:workspaceSymbol",
    async (_event, params: { projectRoot: string; query: string }) => {
      return lspWorkspaceSymbol(params.projectRoot, params.query)
    }
  )

  ipcMain.handle(
    "lsp:diagnostics",
    async (_event, params: { projectRoot: string; filePath?: string }) => {
      return lspDiagnostics(params.projectRoot, params.filePath)
    }
  )

  ipcMain.handle(
    "lsp:prepareCallHierarchy",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspPrepareCallHierarchy(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:incomingCalls",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspIncomingCalls(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:outgoingCalls",
    async (_event, params: { projectRoot: string; filePath: string; line: number; column: number }) => {
      return lspOutgoingCalls(params.projectRoot, params.filePath, params.line, params.column)
    }
  )

  ipcMain.handle(
    "lsp:detectJavaProject",
    async (_event, dirPath: string): Promise<boolean> => {
      return detectJavaProject(dirPath)
    }
  )
}
