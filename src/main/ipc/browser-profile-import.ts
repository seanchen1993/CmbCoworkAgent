import { dialog, type BrowserWindow, type IpcMain } from "electron"
import { getBrowserCdpConfig } from "../storage"
import type {
  BrowserCookieBridgeErrorCode,
  CmbChromeCookie
} from "../../shared/browser-cookie-bridge"
import {
  BUILTIN_BROWSER_LOG_PREFIX,
  type BrowserProfileImportOptions,
  type BrowserProfileImportResult,
  type BrowserProfileImportSkippedWebsite
} from "../../shared/browser-types"
import type { BrowserService } from "../browser/core/browser-service"

type BrowserCookieExportResult = {
  cookies: CmbChromeCookie[]
  skippedCookies: number
}

type BrowserCookieBridgeServerInstance = {
  exportCookies(timeoutMs?: number): Promise<BrowserCookieExportResult>
  start(): Promise<void>
  stop(): void
}

const BROWSER_COOKIE_BRIDGE_ERROR_CODES = new Set<BrowserCookieBridgeErrorCode>([
  "unsupported_platform",
  "native_host_not_registered",
  "extension_not_connected",
  "permission_required",
  "import_in_progress",
  "import_timeout",
  "protocol_error",
  "export_failed"
])
const BROWSER_COOKIE_BRIDGE_LOG_PREFIX = `${BUILTIN_BROWSER_LOG_PREFIX}[BrowserCookieBridge]`

let cookieBridgeServer: BrowserCookieBridgeServerInstance | null = null
let browserProfileImportActiveForSession = false
let browserProfileImportRuntimeEnabled = false
let browserProfileImportRuntimeStartPromise: Promise<void> | null = null

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

async function getCookieBridgeServer(): Promise<BrowserCookieBridgeServerInstance> {
  if (cookieBridgeServer) return cookieBridgeServer
  const { BrowserCookieBridgeServer } =
    await import("../browser/chrome/browser-cookie-bridge-server")
  cookieBridgeServer = new BrowserCookieBridgeServer()
  return cookieBridgeServer
}

async function ensureChromeNativeHostRegistration() {
  const { ensureCmbChromeNativeHostRegistration } =
    await import("../browser/chrome/browser-native-host-installer")
  return ensureCmbChromeNativeHostRegistration()
}

async function readChromeProfileImportData(options: BrowserProfileImportOptions) {
  const { readBrowserProfileImportData } =
    await import("../browser/chrome/browser-profile-importer")
  return readBrowserProfileImportData(options)
}

async function sanitizeChromeExtensionCookieExport(cookies: CmbChromeCookie[]) {
  const { sanitizeExtensionCookieExport } =
    await import("../browser/chrome/browser-extension-cookie-importer")
  return sanitizeExtensionCookieExport(cookies)
}

function getBrowserCookieBridgeErrorCode(error: unknown): BrowserCookieBridgeErrorCode {
  const maybeCode =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined
  return typeof maybeCode === "string" &&
    BROWSER_COOKIE_BRIDGE_ERROR_CODES.has(maybeCode as BrowserCookieBridgeErrorCode)
    ? (maybeCode as BrowserCookieBridgeErrorCode)
    : "export_failed"
}

async function startBrowserProfileImportRuntime(): Promise<void> {
  if (process.platform !== "win32") return
  if (browserProfileImportRuntimeEnabled) return
  if (browserProfileImportRuntimeStartPromise) return browserProfileImportRuntimeStartPromise

  browserProfileImportRuntimeStartPromise = (async () => {
    const server = await getCookieBridgeServer()
    await server.start()
    try {
      await ensureChromeNativeHostRegistration()
    } catch (error) {
      console.warn(
        `${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} registration failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    browserProfileImportRuntimeEnabled = true
  })()
    .catch((error) => {
      browserProfileImportRuntimeEnabled = false
      throw error
    })
    .finally(() => {
      browserProfileImportRuntimeStartPromise = null
    })

  return browserProfileImportRuntimeStartPromise
}

async function importWindowsCookieData(
  window: BrowserWindow,
  browserService: BrowserService
): Promise<BrowserProfileImportResult> {
  let registration: Awaited<ReturnType<typeof ensureChromeNativeHostRegistration>>
  try {
    await startBrowserProfileImportRuntime()
    registration = await ensureChromeNativeHostRegistration()
  } catch (error) {
    return extensionImportFailure(
      error instanceof Error ? error.message : String(error),
      "export_failed"
    )
  }
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
    const server = await getCookieBridgeServer()
    const exported = await server.exportCookies()
    const imported = await sanitizeChromeExtensionCookieExport(exported.cookies)
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
    const code = getBrowserCookieBridgeErrorCode(error)
    return {
      ...extensionImportFailure(error instanceof Error ? error.message : String(error), code),
      extensionId: registration.extensionId
    }
  }
}

export function stopBrowserProfileImportRuntime(): void {
  browserProfileImportRuntimeEnabled = false
  cookieBridgeServer?.stop()
}

export function registerBrowserProfileImportHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null,
  browserService: BrowserService
): void {
  const startupConfig = getBrowserCdpConfig()
  browserProfileImportActiveForSession = startupConfig.profileImportEnabled === true
  if (browserProfileImportActiveForSession) {
    void startBrowserProfileImportRuntime().catch((error) => {
      console.warn(
        `${BROWSER_COOKIE_BRIDGE_LOG_PREFIX} failed to start: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  ipcMain.handle(
    "browser:isProfileImportRuntimeEnabled",
    () => browserProfileImportActiveForSession
  )

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
      if (!browserProfileImportActiveForSession) {
        return profileImportFailure(
          "浏览器数据导入功能在当前会话未生效，请保存配置后重启应用",
          options
        )
      }

      if (process.platform === "win32") {
        return importWindowsCookieData(window, browserService)
      }

      try {
        const imported = await readChromeProfileImportData({
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
}
