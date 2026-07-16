import { execFile } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import { promisify } from "util"
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
    )
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
  const extensionEnabled = booleanField(extensionInstalled.json, "enabled")
  const nativeHostManifestCorrect = booleanField(nativeHostManifest.json, "correct")

  const summary: BrowserChromeDiscoverySummary = {
    chromeInstalled,
    chromeRunning,
    extensionBackendReady: chromeInstalled && extensionEnabled && nativeHostManifestCorrect,
    extensionEnabled,
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
