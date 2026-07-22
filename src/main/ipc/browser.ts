import { dialog, type BrowserWindow, type IpcMain, type MessageBoxOptions } from "electron"
import { BrowserService } from "../browser/browser-service"
import {
  importChromeSessionIntoBrowser
} from "../browser/browser-chrome-session-importer"
import {
  openBrowserChromeSetupTarget
} from "../browser/browser-chrome-discovery"
import {
  getBrowserProfileImportPreview,
  readBrowserProfileImportData
} from "../browser/browser-profile-importer"
import { sanitizeExtensionCookieExport } from "../browser/browser-extension-cookie-importer"
import {
  BrowserCookieBridgeError,
  BrowserCookieBridgeServer
} from "../browser/browser-cookie-bridge-server"
import {
  ensureCmbChromeNativeHostRegistration,
  getCmbChromeNativeHostRegistrationStatus,
  openCmbChromeExtensionSetup
} from "../browser/browser-native-host-installer"
import { getEnabledBrowserPluginRuntime } from "../browser/browser-plugin"
import { setGlobalBrowserService } from "../browser/browser-service-registry"
import type {
  BrowserAttachOptions,
  BrowserChromeSetupAction,
  BrowserChromeSetupOpenResult,
  BrowserChromeSessionImportResult,
  BrowserBounds,
  BrowserClickTarget,
  BrowserNavigateOptions,
  BrowserProfileImportOptions,
  BrowserProfileImportPreview,
  BrowserProfileImportResult,
  BrowserProfileImportSkippedWebsite
} from "../../shared/browser-types"
import type { BrowserCookieBridgeStatus } from "../../shared/browser-cookie-bridge"

const cookieBridgeServer = new BrowserCookieBridgeServer()

function getHttpOrigin(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
    return parsed.origin
  } catch {
    return ""
  }
}

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
  return message.replace(/(cookie|token|session|authorization|password)=([^;\s]+)/gi, "$1=[redacted]")
}

function mergeSkippedWebsites(
  ...lists: Array<BrowserProfileImportSkippedWebsite[] | undefined>
): BrowserProfileImportSkippedWebsite[] {
  const merged = new Map<string, BrowserProfileImportSkippedWebsite>()
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = item.domain || item.url || "(unknown)"
      const current =
        merged.get(key) ??
        {
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
    console.warn(`[BrowserCookieBridge] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })
  void ensureCmbChromeNativeHostRegistration().catch((error) => {
    console.warn(`[BrowserCookieBridge] registration failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  ipcMain.handle("browser:attach", (_event, sessionId: string, options?: BrowserAttachOptions) => {
    return browserService.attach(sessionId, options)
  })

  ipcMain.handle("browser:detach", (_event, sessionId: string) => {
    return browserService.detach(sessionId)
  })

  ipcMain.handle(
    "browser:setBounds",
    (_event, sessionId: string, bounds: BrowserBounds, visible?: boolean) => {
      return browserService.setBounds(sessionId, bounds, visible)
    }
  )

  ipcMain.handle("browser:getCookieBridgeStatus", async (event): Promise<BrowserCookieBridgeStatus> => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      return {
        connected: false,
        error: "拒绝来自未知窗口的浏览器扩展状态请求",
        extensionId: "",
        nativeHostRegistered: false,
        platformSupported: false
      }
    }
    const status = await getCmbChromeNativeHostRegistrationStatus()
    return {
      ...status,
      connected: cookieBridgeServer.connected,
      profileInstanceId: cookieBridgeServer.profileInstanceId
    }
  })

  ipcMain.handle("browser:openCookieBridgeSetup", async (event) => {
    const window = getMainWindow()
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      return { success: false, error: "拒绝来自未知窗口的浏览器扩展安装请求", extensionPath: "" }
    }
    return openCmbChromeExtensionSetup()
  })

  ipcMain.handle(
    "browser:navigate",
    async (_event, sessionId: string, url: string, options?: BrowserNavigateOptions) => {
      return browserService.navigate(sessionId, url, options)
    }
  )

  ipcMain.handle("browser:goBack", (_event, sessionId: string) => browserService.goBack(sessionId))

  ipcMain.handle("browser:goForward", (_event, sessionId: string) =>
    browserService.goForward(sessionId)
  )

  ipcMain.handle("browser:reload", (_event, sessionId: string) => browserService.reload(sessionId))

  ipcMain.handle("browser:stop", (_event, sessionId: string) => browserService.stop(sessionId))

  ipcMain.handle("browser:clearConsole", (_event, sessionId: string) =>
    browserService.clearConsole(sessionId)
  )

  ipcMain.handle("browser:getState", (_event, sessionId: string) =>
    browserService.getState(sessionId)
  )

  ipcMain.handle("browser:captureScreenshot", (_event, sessionId: string) =>
    browserService.captureScreenshot(sessionId)
  )

  ipcMain.handle("browser:readRenderedState", (_event, sessionId: string, includeHtml?: boolean) =>
    browserService.readRenderedState(sessionId, includeHtml)
  )

  ipcMain.handle("browser:click", (_event, sessionId: string, target: BrowserClickTarget) =>
    browserService.click(sessionId, target)
  )

  ipcMain.handle("browser:typeText", (_event, sessionId: string, text: string) =>
    browserService.typeText(sessionId, text)
  )

  ipcMain.handle("browser:press", (_event, sessionId: string, keyCode: string) =>
    browserService.press(sessionId, keyCode)
  )

  ipcMain.handle(
    "browser:getProfileImportPreview",
    async (event): Promise<BrowserProfileImportPreview> => {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
        return {
          sourceBrowser: "chrome",
          profiles: [],
          error: "拒绝来自未知窗口的浏览器数据导入预览请求"
        }
      }
      return getBrowserProfileImportPreview()
    }
  )

  ipcMain.handle(
    "browser:importProfileData",
    async (
      event,
      options?: BrowserProfileImportOptions
    ): Promise<BrowserProfileImportResult> => {
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
        const skippedWebsites = mergeSkippedWebsites(imported.skippedWebsites, counts.skippedWebsites)
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

  ipcMain.handle(
    "browser:importChromeSession",
    async (
      event,
      sessionId: string,
      options?: { threadId?: string; workspacePath?: string | null }
    ): Promise<BrowserChromeSessionImportResult> => {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
        return { success: false, error: "拒绝来自未知窗口的 Chrome 登录态导入请求" }
      }
      const state = browserService.getState(sessionId)
      if (!state.created) {
        return { success: false, error: "内置浏览器还没有打开页面" }
      }
      const targetOrigin = state.url ? getHttpOrigin(state.url) : ""
      if (!targetOrigin) {
        return { success: false, error: "当前内置浏览器页面不是可导入登录态的 HTTP(S) 页面" }
      }
      const messageBoxOptions: MessageBoxOptions = {
        type: "question",
        title: "导入 Chrome 登录态",
        message: "从已打开的 Chrome 导入当前页面的 Cookie 和 localStorage？",
        detail:
          targetOrigin.length > 0
            ? `目标页面：${targetOrigin}\n\n只会导入同源 tab 的 Cookie 和 localStorage，不会导入密码。`
            : "只会导入同源 tab 的 Cookie 和 localStorage，不会导入密码。",
        buttons: ["取消", "导入"],
        defaultId: 1,
        cancelId: 0
      }
      const result = await dialog.showMessageBox(window, messageBoxOptions)
      if (result.response !== 1) {
        return { success: false, cancelled: true, targetOrigin: targetOrigin || undefined }
      }

      return importChromeSessionIntoBrowser({
        service: browserService,
        sessionId,
        threadId: options?.threadId,
        workspacePath: options?.workspacePath ?? null
      })
    }
  )

  ipcMain.handle(
    "browser:openChromeSetup",
    async (event, action: BrowserChromeSetupAction): Promise<BrowserChromeSetupOpenResult> => {
      const window = getMainWindow()
      if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id) {
        return { action, success: false, error: "拒绝来自未知窗口的 Chrome setup 请求" }
      }
      if (
        action !== "open-chrome" &&
        action !== "install-extension" &&
        action !== "enable-extension" &&
        action !== "reinstall-plugin"
      ) {
        return { action, success: false, error: "不支持的 Chrome setup action" }
      }
      const plugin = getEnabledBrowserPluginRuntime()
      if (!plugin) {
        return { action, success: false, error: "Browser 插件 runtime 未启用" }
      }
      return openBrowserChromeSetupTarget(plugin, action)
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
        registration.error || "CmbCoworkAgent Chrome 扩展尚未配置",
        "native_host_not_registered"
      ),
      extensionId: registration.extensionId,
      extensionPath: registration.extensionPath
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
    const skippedCookies =
      exported.skippedCookies + imported.skippedCookies + counts.skippedCookies
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
      extensionId: registration.extensionId,
      extensionPath: registration.extensionPath
    }
  }
}
