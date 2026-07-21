import type {
  BrowserChromeBackendDiagnostics,
  BrowserChromeSessionImportResult
} from "../../shared/browser-types"
import { getEnabledBrowserPluginRuntime } from "./browser-plugin"
import {
  buildBrowserChromeBackendDiagnostics,
  checkBrowserChromeEnvironment
} from "./browser-chrome-discovery"
import type {
  BrowserSessionCookie,
  BrowserSessionData,
  BrowserSessionStorageEntry
} from "./browser-session-data"
import type { BrowserService } from "./browser-service"
import {
  bindOfficialBrowserRuntimeGlobals,
  setupOfficialBrowserRuntime
} from "./official-browser-runtime-loader"
import { createBrowserRuntimeNodeReplHost } from "../agent/tools/browser/browser-runtime-host"

const MAX_IMPORTED_COOKIES = 500
const MAX_IMPORTED_LOCAL_STORAGE_ENTRIES = 200
const MAX_IMPORTED_STORAGE_KEY_CHARS = 2_000
const MAX_IMPORTED_STORAGE_VALUE_CHARS = 200_000

interface BrowserRuntimeNodeReplForImport {
  config: {
    writeToml(key: string, value: unknown): Promise<void>
  }
  env: NodeJS.ProcessEnv
}

interface ChromeSessionExport {
  cookies?: unknown
  localStorage?: unknown
  sourceOrigin?: unknown
}

export interface BrowserChromeSessionImportOptions {
  service: BrowserService
  sessionId: string
  threadId?: string
  workspacePath?: string | null
}

function createAsyncRunner(
  code: string
): (globals: Record<string, unknown>) => Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async function asyncFunctionSource() {
    return undefined
  }).constructor as new (
    ...args: string[]
  ) => (globals: Record<string, unknown>) => Promise<unknown>

  return new AsyncFunction(
    "globals",
    `
      const globalThis = globals;
      with (globals) {
        return await (async () => {
          ${code}
        })();
      }
    `
  )
}

function getHttpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return parsed.origin
  } catch {
    return null
  }
}

function stringValue(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" && value.length <= maxChars ? value : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function sanitizeCookies(value: unknown): BrowserSessionCookie[] {
  if (!Array.isArray(value)) return []
  const cookies: BrowserSessionCookie[] = []
  for (const item of value) {
    if (cookies.length >= MAX_IMPORTED_COOKIES) break
    const record = recordValue(item)
    const name = stringValue(record.name, 4_096)
    const rawValue = stringValue(record.value, 200_000)
    if (!name || rawValue === undefined) continue
    cookies.push({
      name,
      value: rawValue,
      ...(stringValue(record.domain, 4_096) ? { domain: stringValue(record.domain, 4_096) } : {}),
      ...(numberValue(record.expires) ? { expires: numberValue(record.expires) } : {}),
      ...(booleanValue(record.httpOnly) !== undefined ? { httpOnly: booleanValue(record.httpOnly) } : {}),
      ...(stringValue(record.path, 4_096) ? { path: stringValue(record.path, 4_096) } : {}),
      ...(record.partitionKey !== undefined ? { partitionKey: record.partitionKey } : {}),
      ...(stringValue(record.sameSite, 32) ? { sameSite: stringValue(record.sameSite, 32) } : {}),
      ...(booleanValue(record.secure) !== undefined ? { secure: booleanValue(record.secure) } : {})
    })
  }
  return cookies
}

function sanitizeLocalStorage(value: unknown): BrowserSessionStorageEntry[] {
  if (!Array.isArray(value)) return []
  const entries: BrowserSessionStorageEntry[] = []
  for (const item of value) {
    if (entries.length >= MAX_IMPORTED_LOCAL_STORAGE_ENTRIES) break
    const record = recordValue(item)
    const key = stringValue(record.key, MAX_IMPORTED_STORAGE_KEY_CHARS)
    const entryValue = stringValue(record.value, MAX_IMPORTED_STORAGE_VALUE_CHARS)
    if (!key || entryValue === undefined) continue
    entries.push({ key, value: entryValue })
  }
  return entries
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/cdp|capability/i.test(message)) {
    return "Chrome backend 没有开放受限 CDP Cookie 读取能力"
  }
  if (/No browser is available|Browser is not available/i.test(message)) {
    return "没有发现可用的 Chrome Browser backend，请确认 Chrome 扩展和 native host 已启用"
  }
  return message.replace(/(cookie|token|session|authorization|password)=([^;\s]+)/gi, "$1=[redacted]")
}

function isChromeBackendUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /No browser is available|Browser is not available/i.test(message)
}

function messageForChromeDiagnostics(
  diagnostics: BrowserChromeBackendDiagnostics | undefined,
  fallback: string
): string {
  if (!diagnostics) return fallback
  if (!diagnostics.chromeInstalled) {
    return "没有检测到 Google Chrome，Chrome 登录态导入需要本机 Chrome"
  }
  if (!diagnostics.chromeRunning) {
    return "Google Chrome 还没有启动，请先打开 Chrome 后重试"
  }
  if (!diagnostics.extensionInstalled) {
    return "Cannot communicate with the Codex Chrome Extension. Confirm that the extension is installed and enabled in Chrome."
  }
  if (!diagnostics.extensionEnabled) {
    return "Codex Chrome Extension 未启用，请在 Google Chrome Extension Manager 中启用后重试"
  }
  if (!diagnostics.nativeHostManifestCorrect) {
    return "Chrome native host manifest 不正确，请从插件管理界面重新安装 Browser/Chrome 插件"
  }
  return fallback
}

async function loadChromeDiagnostics(): Promise<BrowserChromeBackendDiagnostics | undefined> {
  const plugin = getEnabledBrowserPluginRuntime()
  if (!plugin) return undefined
  try {
    const discovery = await checkBrowserChromeEnvironment({ pluginRoot: plugin.pluginRoot })
    return await buildBrowserChromeBackendDiagnostics(plugin.pluginRoot, discovery)
  } catch (error) {
    console.warn(
      `[BrowserRuntime] chrome diagnostics failed: ${error instanceof Error ? error.message : String(error)}.`
    )
    return undefined
  }
}

function chromeSessionExportScript(): string {
  return `
    const targetUrl = String(globalThis.__cmbChromeSessionImportTargetUrl || "");
    const target = new URL(targetUrl);
    const sameUrlWithoutHash = (a, b) => {
      const left = new URL(a);
      const right = new URL(b);
      left.hash = "";
      right.hash = "";
      return left.href === right.href;
    };
    const getExtensionBrowser = async () => {
      try {
        return await agent.browsers.get("extension");
      } catch (firstError) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return await agent.browsers.get("extension");
      }
    };
    const browser = await getExtensionBrowser();
    try {
      await browser.nameSession("Chrome session import");
    } catch {}

    const openTabs = await browser.user.openTabs();
    const candidates = [];
    for (const tab of openTabs) {
      if (!tab || typeof tab.url !== "string") continue;
      try {
        const parsed = new URL(tab.url);
        if (parsed.origin === target.origin) {
          candidates.push({
            tab,
            exact: sameUrlWithoutHash(parsed.href, target.href),
            lastOpened: typeof tab.lastOpened === "string" ? Date.parse(tab.lastOpened) || 0 : 0
          });
        }
      } catch {}
    }
    candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.lastOpened - a.lastOpened);
    if (candidates.length === 0) {
      throw new Error("Chrome 中没有打开与当前内置浏览器页面同源的 tab");
    }

    let claimedTab = null;
    try {
      claimedTab = await browser.user.claimTab(candidates[0].tab);
      const sourceUrl = await claimedTab.url().catch(() => candidates[0].tab.url || target.href);
      const sourceOrigin = new URL(sourceUrl || candidates[0].tab.url || target.href).origin;
      if (sourceOrigin !== target.origin) {
        throw new Error("Chrome tab origin changed before session import");
      }

      const cdp = await claimedTab.capabilities.get("cdp");
      const cookiePayload = await cdp.send(
        "Network.getCookies",
        { urls: [target.href] },
        { timeoutMs: 10000 }
      );
      const localStorage = await claimedTab.playwright
        .evaluate(() => {
          const entries = [];
          try {
            for (let index = 0; index < window.localStorage.length; index += 1) {
              const key = window.localStorage.key(index);
              if (typeof key === "string") {
                entries.push({ key, value: window.localStorage.getItem(key) || "" });
              }
            }
          } catch {}
          return entries;
        })
        .catch(() => []);

      return {
        sourceOrigin,
        cookies: Array.isArray(cookiePayload?.cookies) ? cookiePayload.cookies : [],
        localStorage: Array.isArray(localStorage) ? localStorage : []
      };
    } finally {
      if (claimedTab) {
        try {
          await browser.tabs.finalize({ keep: [{ tab: claimedTab, status: "handoff" }] });
        } catch {}
      }
    }
  `
}

async function exportChromeSessionData(options: {
  targetUrl: string
  threadId?: string
  workspacePath: string
}): Promise<{ data: BrowserSessionData; sourceOrigin: string }> {
  const plugin = getEnabledBrowserPluginRuntime()
  if (!plugin) {
    throw new Error("Browser 插件 runtime 未启用")
  }

  const host = createBrowserRuntimeNodeReplHost({
    workspacePath: options.workspacePath,
    threadId: `${options.threadId || "unbound"}-chrome-session-import`
  })
  try {
    const nodeRepl = host.globals.nodeRepl as BrowserRuntimeNodeReplForImport
    nodeRepl.env.BROWSER_USE_AVAILABLE_BACKENDS = "chrome"
    await nodeRepl.config.writeToml("browser/config.toml", {
      full_cdp_access_enabled: true
    })
    host.globals.__cmbChromeSessionImportTargetUrl = options.targetUrl

    await host.ready()
    await setupOfficialBrowserRuntime({
      clientPath: plugin.clientPath,
      globals: host.globals,
      budget: host.budget
    })
    bindOfficialBrowserRuntimeGlobals(host.globals)

    const exported = (await createAsyncRunner(chromeSessionExportScript())(
      host.globals
    )) as ChromeSessionExport
    const sourceOrigin = stringValue(exported.sourceOrigin, 4_096)
    if (!sourceOrigin) throw new Error("Chrome session export did not include a source origin")

    const cookies = sanitizeCookies(exported.cookies)
    const localStorage = sanitizeLocalStorage(exported.localStorage)
    console.info(
      `[BrowserRuntime] Chrome session data exported for ${sourceOrigin} cookies=${cookies.length} localStorage=${localStorage.length}.`
    )
    return {
      data: { cookies, localStorage },
      sourceOrigin
    }
  } finally {
    host.dispose()
  }
}

export async function importChromeSessionIntoBrowser(
  options: BrowserChromeSessionImportOptions
): Promise<BrowserChromeSessionImportResult> {
  const state = options.service.getState(options.sessionId)
  if (!state.created) {
    return { success: false, error: "内置浏览器还没有打开页面" }
  }

  const targetOrigin = getHttpOrigin(state.url)
  if (!targetOrigin) {
    return { success: false, error: "当前内置浏览器页面不是可导入登录态的 HTTP(S) 页面" }
  }

  try {
    const exported = await exportChromeSessionData({
      targetUrl: state.url,
      threadId: options.threadId,
      workspacePath: options.workspacePath || process.cwd()
    })
    if (exported.sourceOrigin !== targetOrigin) {
      return {
        success: false,
        sourceOrigin: exported.sourceOrigin,
        targetOrigin,
        error: "Chrome tab 与当前内置浏览器页面不是同一个 origin"
      }
    }

    const counts = await options.service.importSessionData(options.sessionId, exported.data)
    return {
      success: true,
      sourceOrigin: exported.sourceOrigin,
      targetOrigin,
      ...counts,
      warning:
        counts.importedCookies === 0 && counts.importedLocalStorage === 0
          ? "没有可导入的 Cookie 或 localStorage"
          : undefined
    }
  } catch (error) {
    const chromeDiagnostics = isChromeBackendUnavailable(error)
      ? await loadChromeDiagnostics()
      : undefined
    const sanitizedError = sanitizeErrorMessage(error)
    return {
      success: false,
      chromeDiagnostics,
      targetOrigin,
      error: messageForChromeDiagnostics(chromeDiagnostics, sanitizedError)
    }
  }
}
