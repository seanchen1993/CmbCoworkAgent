import { dialog, type BrowserWindow, type IpcMain } from "electron"
import { BrowserService } from "../browser/core/browser-service"
import { readBrowserProfileImportData } from "../browser/chrome/browser-profile-importer"
import { sanitizeExtensionCookieExport } from "../browser/chrome/browser-extension-cookie-importer"
import {
  BrowserCookieBridgeError,
  BrowserCookieBridgeServer
} from "../browser/chrome/browser-cookie-bridge-server"
import { ensureCmbChromeNativeHostRegistration } from "../browser/chrome/browser-native-host-installer"
import { setGlobalBrowserService } from "../browser/core/browser-service-registry"
import type {
  BrowserAttachOptions,
  BrowserBounds,
  BrowserNavigateOptions,
  BrowserProfileImportOptions,
  BrowserProfileImportResult,
  BrowserProfileImportSkippedWebsite
} from "../../shared/browser-types"

const cookieBridgeServer = new BrowserCookieBridgeServer()

function profileImportFailure(
  error: string,
  options?: Partial<BrowserProfileImportOptions>
): BrowserProfileImportResult {
  return {
    success: false,
    sourceBrowser: options?.sourceBrowser ?? "chrome",
    profileDirectory: options?.profileDirectory,
    importedCookies: 0,
    importedLocalStorage: 0,
    skippedCookies: 0,
    skippedLocalStorage: 0,
    error
  }
}

function extensionImportFailure(
  error: string,
  errorCode: BrowserProfileImportResult["errorCode"]
): BrowserProfileImportResult {
  return {
    error,
    errorCode,
    importMethod: "extension",
    importedCookies: 0,
    importedLocalStorage: 0,
    skippedCookies: 0,
    skippedLocalStorage: 0,
    sourceBrowser: "chrome",
    success: false
  }
}

function sanitizeProfileImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(
    /(cookie|token|session|authorization|password)=([^;\s]+)/gi,
    "$1=[redacted]"
  )
}

function mergeSkippedWebsites(
  ...lists: Array<BrowserProfileImportSkippedWebsite[] | undefined>
): BrowserProfileImportSkippedWebsite[] {
  const merged = new Map<string, BrowserProfileImportSkippedWebsite>()
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = item.domain || item.url || "(unknown)"
      const current = merged.get(key) ?? {
        domain: item.domain || "(unknown)",
        reasons: [],
        skippedCookies: 0,
        url: item.url
      }
      current.skippedCookies += item.skippedCookies
      current.url = current.url || item.url
      for (const reason of item.reasons) {
        if (!current.reasons.includes(reason)) current.reasons.push(reason)
      }
      merged.set(key, current)
    }
  }
  return Array.from(merged.values()).sort(
    (left, right) =>
      right.skippedCookies - left.skippedCookies || left.domain.localeCompare(right.domain)
  )
}

export function registerBrowserHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): BrowserService {
  const browserService = new BrowserService(getMainWindow)
  setGlobalBrowserService(browserService)
  void cookieBridgeServer.start().catch((error) => {
    console.warn(
      `[BrowserCookieBridge] failed to start: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  void ensureCmbChromeNativeHostRegistration().catch((error) => {
    console.warn(
      `[BrowserCookieBridge] registration failed: ${error instanceof Error ? error.message : String(error)}`
    )
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
        `[BrowserService] Ignored renderer-unload cleanup from unknown sender ${event.sender.id}.`
      )
      return
    }

    const disposedSessionId = browserService.disposeAll()
    console.info(
      `[BrowserService] Renderer unload cleanup requested by sender ${event.sender.id}; disposed=${disposedSessionId ?? "(none)"}.`
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

  ipcMain.handle("browser:captureScreenshot", () => browserService.captureScreenshot())

  ipcMain.handle(
    "browser:importProfileData",
    async (event, options?: BrowserProfileImportOptions): Promise<BrowserProfileImportResult> => {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
        return profileImportFailure("拒绝来自未知窗口的浏览器数据导入请求", options)
      }
      if (!options || options.sourceBrowser !== "chrome") {
        return profileImportFailure("不支持的浏览器数据导入来源", options)
      }

      if (process.platform === "win32") {
        return importWindowsCookieData(window, browserService)
      }

      try {
        const imported = await readBrowserProfileImportData({
          sourceBrowser: "chrome",
          profileDirectory: options.profileDirectory,
          importCookies: options.importCookies !== false
        })
        const counts = await browserService.importProfileData(imported.data)
        const skippedCookies = counts.skippedCookies + imported.skippedCookies
        const skippedWebsites = mergeSkippedWebsites(
          imported.skippedWebsites,
          counts.skippedWebsites
        )
        return {
          success: true,
          sourceBrowser: "chrome",
          importMethod: "profile",
          profileDirectory: imported.profileDirectory,
          importedCookies: counts.importedCookies,
          importedLocalStorage: counts.importedLocalStorage,
          skippedCookies,
          skippedLocalStorage: counts.skippedLocalStorage,
          skippedWebsites,
          warning:
            counts.importedCookies === 0
              ? "没有成功导入 Cookie，可能是 Chrome profile 没有可导入站点数据或 Cookie 加密不可解"
              : skippedCookies > 0
                ? "部分 Cookie 因加密、分区或格式限制被跳过"
                : undefined
        }
      } catch (error) {
        return profileImportFailure(sanitizeProfileImportError(error), options)
      }
    }
  )

  return browserService
}

async function importWindowsCookieData(
  window: BrowserWindow,
  browserService: BrowserService
): Promise<BrowserProfileImportResult> {
  const registration = await ensureCmbChromeNativeHostRegistration()
  if (!registration.nativeHostRegistered) {
    return {
      ...extensionImportFailure(
        registration.error || "Chrome Native Messaging Host 尚未注册",
        "native_host_not_registered"
      ),
      extensionId: registration.extensionId
    }
  }

  const confirmation = await dialog.showMessageBox(window, {
    type: "question",
    title: "导入 Chrome Cookie",
    message: "从当前 Chrome Profile 导入全部网站 Cookie？",
    detail:
      "Cookie 将由 CmbCoworkAgent Chrome 扩展读取，不会读取 Chrome 的 Cookies 文件。请确认你已在扩展中授予网站访问权限。",
    buttons: ["取消", "导入"],
    defaultId: 1,
    cancelId: 0
  })
  if (confirmation.response !== 1) {
    return { ...extensionImportFailure("用户取消导入", undefined), cancelled: true }
  }

  try {
    const exported = await cookieBridgeServer.exportCookies()
    const imported = sanitizeExtensionCookieExport(exported.cookies)
    const counts = await browserService.importProfileData(imported.data)
    const skippedCookies = exported.skippedCookies + imported.skippedCookies + counts.skippedCookies
    return {
      success: true,
      sourceBrowser: "chrome",
      importMethod: "extension",
      importedCookies: counts.importedCookies,
      importedLocalStorage: 0,
      skippedCookies,
      skippedLocalStorage: 0,
      skippedWebsites: counts.skippedWebsites,
      warning:
        counts.importedCookies === 0
          ? "Chrome 扩展没有返回可导入 Cookie，请确认已授权网站访问权限"
          : skippedCookies > 0
            ? "部分 Cookie 因分区、格式或内置浏览器限制被跳过"
            : undefined
    }
  } catch (error) {
    const code = error instanceof BrowserCookieBridgeError ? error.code : "export_failed"
    return {
      ...extensionImportFailure(error instanceof Error ? error.message : String(error), code),
      extensionId: registration.extensionId
    }
  }
}
