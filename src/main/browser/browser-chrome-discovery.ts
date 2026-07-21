import { execFile, spawn } from "child_process"
import { existsSync } from "fs"
import { readFile } from "fs/promises"
import { join } from "path"
import { promisify } from "util"
import type {
  BrowserChromeBackendDiagnostics,
  BrowserChromeSetupAction,
  BrowserChromeSetupOpenResult
} from "../../shared/browser-types"
import type { BrowserPluginRuntime } from "./browser-plugin"

const execFileAsync = promisify(execFile)

export const BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES = {
  chromeIsRunning: "chrome-is-running.js",
  checkExtensionInstalled: "check-extension-installed.js",
  checkNativeHostManifest: "check-native-host-manifest.js",
  installedBrowsers: "installed-browsers.js"
} as const

export type BrowserChromeDiscoveryScriptName =
  (typeof BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES)[keyof typeof BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES]

export interface BrowserChromeScriptPaths {
  chromeIsRunning: string
  checkExtensionInstalled: string
  checkNativeHostManifest: string
  installedBrowsers: string
  openChromeWindow: string
}

export interface BrowserChromeScriptResult<T = unknown> {
  error?: string
  exitCode: number | null
  json?: T
  ok: boolean
  scriptName: BrowserChromeDiscoveryScriptName
  scriptPath: string
  stderr: string
  stdout: string
}

export interface BrowserChromeDiscoveryOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface BrowserChromeDiscoverySummary {
  chromeInstalled: boolean
  chromeRunning: boolean
  extensionBackendReady: boolean
  extensionEnabled: boolean
  extensionInstalled: boolean
  nativeHostManifestCorrect: boolean
}

export interface BrowserChromeDiscoveryResult {
  extensionInstalled: BrowserChromeScriptResult
  installedBrowsers: BrowserChromeScriptResult
  nativeHostManifest: BrowserChromeScriptResult
  running: BrowserChromeScriptResult
  scriptPaths: BrowserChromeScriptPaths
  summary: BrowserChromeDiscoverySummary
}

interface ChildProcessError extends Error {
  code?: number | string
  signal?: string
  stderr?: Buffer | string
  stdout?: Buffer | string
}

const DEFAULT_CHROME_DISCOVERY_TIMEOUT_MS = 5_000
const MAX_CHROME_DISCOVERY_OUTPUT_BYTES = 512_000
const CHROME_EXTENSION_CONFIG_FILENAME = "extension-id.json"
const CHROME_EXTENSION_MANAGER_URL = "chrome://extensions/"
const BROWSER_CHROME_OPEN_WINDOW_SCRIPT_NAME = "open-chrome-window.js"
const CODEX_CHROME_EXTENSION_WEBSTORE_BASE_URL = "https://chromewebstore.google.com/detail/codex"

interface BrowserChromeExtensionConfig {
  extensionId?: string
}

interface BrowserChromeOpenWindowPlan {
  args?: unknown
  command?: unknown
}

function scriptPath(pluginRoot: string, scriptName: BrowserChromeDiscoveryScriptName): string {
  return join(pluginRoot, "scripts", scriptName)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function bufferString(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8")
  return typeof value === "string" ? value : ""
}

function exitCodeFromError(error: ChildProcessError): number | null {
  return typeof error.code === "number" ? error.code : null
}

function parseJsonOutput(stdout: string): { error?: string; json?: unknown } {
  const trimmed = stdout.trim()
  if (!trimmed) return {}
  try {
    return { json: JSON.parse(trimmed) }
  } catch (error) {
    return {
      error: `Could not parse Browser Chrome discovery JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}

function hasInstalledChrome(json: unknown): boolean {
  const installed = asRecord(json).installed_browsers
  return Array.isArray(installed) && installed.length > 0
}

function booleanField(json: unknown, field: string): boolean {
  return asRecord(json)[field] === true
}

function stringField(json: unknown, field: string): string | undefined {
  const value = asRecord(json)[field]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function mergeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env
  }
}

export function getBrowserChromeScriptPaths(pluginRoot: string): BrowserChromeScriptPaths {
  return {
    chromeIsRunning: scriptPath(
      pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.chromeIsRunning
    ),
    checkExtensionInstalled: scriptPath(
      pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkExtensionInstalled
    ),
    checkNativeHostManifest: scriptPath(
      pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkNativeHostManifest
    ),
    installedBrowsers: scriptPath(
      pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.installedBrowsers
    ),
    openChromeWindow: join(pluginRoot, "scripts", BROWSER_CHROME_OPEN_WINDOW_SCRIPT_NAME)
  }
}

async function readChromeExtensionId(pluginRoot: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(pluginRoot, "scripts", CHROME_EXTENSION_CONFIG_FILENAME), "utf8")
    const config = JSON.parse(raw) as BrowserChromeExtensionConfig
    return typeof config.extensionId === "string" && config.extensionId.length > 0
      ? config.extensionId
      : undefined
  } catch {
    return undefined
  }
}

function extensionInstallUrl(extensionId: string | undefined): string | undefined {
  return extensionId ? `${CODEX_CHROME_EXTENSION_WEBSTORE_BASE_URL}/${extensionId}` : undefined
}

function recommendedActionForSummary(
  summary: BrowserChromeDiscoverySummary
): BrowserChromeSetupAction | undefined {
  if (!summary.chromeInstalled) return undefined
  if (!summary.chromeRunning) return "open-chrome"
  if (!summary.extensionInstalled) return "install-extension"
  if (!summary.extensionEnabled) return "enable-extension"
  if (!summary.nativeHostManifestCorrect) return "reinstall-plugin"
  if (!summary.extensionBackendReady) return "open-chrome"
  return undefined
}

function recommendedActionLabel(action: BrowserChromeSetupAction | undefined): string | undefined {
  switch (action) {
    case "open-chrome":
      return "打开 Chrome"
    case "install-extension":
      return "打开安装页"
    case "enable-extension":
      return "打开扩展管理"
    case "reinstall-plugin":
      return "重装插件"
    default:
      return undefined
  }
}

export async function buildBrowserChromeBackendDiagnostics(
  pluginRoot: string,
  result: BrowserChromeDiscoveryResult
): Promise<BrowserChromeBackendDiagnostics> {
  const extensionId =
    stringField(result.extensionInstalled.json, "extensionId") ??
    stringField(result.nativeHostManifest.json, "expectedExtensionId") ??
    (await readChromeExtensionId(pluginRoot))
  const recommendedAction = recommendedActionForSummary(result.summary)

  return {
    ...result.summary,
    extensionId,
    extensionInstallUrl: extensionInstallUrl(extensionId),
    extensionManagerUrl: CHROME_EXTENSION_MANAGER_URL,
    recommendedAction,
    recommendedActionLabel: recommendedActionLabel(recommendedAction),
    selectedProfileDirectory: stringField(
      result.extensionInstalled.json,
      "selectedProfileDirectory"
    )
  }
}

function replaceAboutBlankArg(args: unknown[], targetUrl: string): string[] {
  const stringArgs = args.flatMap((arg) => (typeof arg === "string" ? [arg] : []))
  const index = stringArgs.findIndex((arg) => arg === "about:blank")
  if (index >= 0) {
    stringArgs[index] = targetUrl
    return stringArgs
  }
  return [...stringArgs, targetUrl]
}

async function getOpenChromeWindowPlan(pluginRoot: string): Promise<{ command: string; args: string[] }> {
  const targetPath = join(pluginRoot, "scripts", BROWSER_CHROME_OPEN_WINDOW_SCRIPT_NAME)
  if (!existsSync(targetPath)) {
    throw new Error(`Browser Chrome setup script is missing: ${targetPath}`)
  }

  const result = await execFileAsync(process.execPath, [targetPath, "--dry-run", "--json"], {
    maxBuffer: MAX_CHROME_DISCOVERY_OUTPUT_BYTES,
    timeout: DEFAULT_CHROME_DISCOVERY_TIMEOUT_MS
  })
  const parsed = JSON.parse(result.stdout) as BrowserChromeOpenWindowPlan
  if (typeof parsed.command !== "string" || !Array.isArray(parsed.args)) {
    throw new Error("Browser Chrome setup script returned an invalid launch plan")
  }
  return {
    command: parsed.command,
    args: parsed.args.flatMap((arg) => (typeof arg === "string" ? [arg] : []))
  }
}

function targetUrlForSetupAction(
  action: BrowserChromeSetupAction,
  extensionId: string | undefined
): string | null {
  switch (action) {
    case "open-chrome":
      return "about:blank"
    case "install-extension":
      return extensionInstallUrl(extensionId) ?? null
    case "enable-extension":
      return CHROME_EXTENSION_MANAGER_URL
    case "reinstall-plugin":
      return null
  }
}

export async function openBrowserChromeSetupTarget(
  plugin: Pick<BrowserPluginRuntime, "pluginRoot">,
  action: BrowserChromeSetupAction
): Promise<BrowserChromeSetupOpenResult> {
  const extensionId = await readChromeExtensionId(plugin.pluginRoot)
  const targetUrl = targetUrlForSetupAction(action, extensionId)
  if (!targetUrl) {
    return {
      action,
      success: false,
      error: "当前恢复动作需要在插件管理界面手动重新安装 Browser/Chrome 插件"
    }
  }

  try {
    const plan = await getOpenChromeWindowPlan(plugin.pluginRoot)
    const child = spawn(plan.command, replaceAboutBlankArg(plan.args, targetUrl), {
      detached: true,
      stdio: "ignore"
    })
    child.unref()
    console.log(`[BrowserRuntime] chrome setup opened ${action}.`)
    return { action, success: true, targetUrl }
  } catch (error) {
    return {
      action,
      success: false,
      targetUrl,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function runBrowserChromeJsonScript<T = unknown>(
  pluginRoot: string,
  scriptName: BrowserChromeDiscoveryScriptName,
  options: BrowserChromeDiscoveryOptions = {}
): Promise<BrowserChromeScriptResult<T>> {
  const targetPath = scriptPath(pluginRoot, scriptName)
  if (!existsSync(targetPath)) {
    return {
      error: `Browser Chrome discovery script is missing: ${targetPath}`,
      exitCode: null,
      ok: false,
      scriptName,
      scriptPath: targetPath,
      stderr: "",
      stdout: ""
    }
  }

  try {
    const result = await execFileAsync(process.execPath, [targetPath, "--json"], {
      env: mergeEnv(options.env),
      maxBuffer: MAX_CHROME_DISCOVERY_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_CHROME_DISCOVERY_TIMEOUT_MS
    })
    const parsed = parseJsonOutput(result.stdout)
    return {
      error: parsed.error,
      exitCode: 0,
      json: parsed.json as T,
      ok: !parsed.error,
      scriptName,
      scriptPath: targetPath,
      stderr: result.stderr,
      stdout: result.stdout
    }
  } catch (rawError) {
    const error = rawError as ChildProcessError
    const stdout = bufferString(error.stdout)
    const stderr = bufferString(error.stderr)
    const parsed = parseJsonOutput(stdout)
    return {
      error: parsed.error ?? error.message,
      exitCode: exitCodeFromError(error),
      json: parsed.json as T,
      ok: false,
      scriptName,
      scriptPath: targetPath,
      stderr,
      stdout
    }
  }
}

export async function checkBrowserChromeEnvironment(
  plugin: Pick<BrowserPluginRuntime, "pluginRoot">,
  options: BrowserChromeDiscoveryOptions = {}
): Promise<BrowserChromeDiscoveryResult> {
  const [
    installedBrowsers,
    running,
    extensionInstalled,
    nativeHostManifest
  ] = await Promise.all([
    runBrowserChromeJsonScript(
      plugin.pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.installedBrowsers,
      options
    ),
    runBrowserChromeJsonScript(
      plugin.pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.chromeIsRunning,
      options
    ),
    runBrowserChromeJsonScript(
      plugin.pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkExtensionInstalled,
      options
    ),
    runBrowserChromeJsonScript(
      plugin.pluginRoot,
      BROWSER_CHROME_DISCOVERY_SCRIPT_NAMES.checkNativeHostManifest,
      options
    )
  ])

  const chromeInstalled = hasInstalledChrome(installedBrowsers.json)
  const chromeRunning = booleanField(running.json, "running")
  const extensionInstalledFlag = booleanField(extensionInstalled.json, "installed")
  const extensionEnabled = booleanField(extensionInstalled.json, "enabled")
  const nativeHostManifestCorrect = booleanField(nativeHostManifest.json, "correct")

  const summary: BrowserChromeDiscoverySummary = {
    chromeInstalled,
    chromeRunning,
    extensionBackendReady:
      chromeInstalled && chromeRunning && extensionInstalledFlag && extensionEnabled && nativeHostManifestCorrect,
    extensionEnabled,
    extensionInstalled: extensionInstalledFlag,
    nativeHostManifestCorrect
  }

  console.log(
    `[BrowserRuntime] chrome discovery completed with backendReady=${summary.extensionBackendReady}.`
  )

  return {
    extensionInstalled,
    installedBrowsers,
    nativeHostManifest,
    running,
    scriptPaths: getBrowserChromeScriptPaths(plugin.pluginRoot),
    summary
  }
}
