import { execFile } from "child_process"
import { access, mkdir, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { promisify } from "util"
import { app } from "electron"
import {
  CMB_CHROME_EXTENSION_ID,
  CMB_CHROME_EXTENSION_ORIGIN,
  CMB_CHROME_NATIVE_HOST_NAME,
  type BrowserCookieBridgeStatus
} from "../../shared/browser-cookie-bridge"
import {
  getBrowserCookieBridgeDirectory,
  getBrowserCookieBridgeSecret
} from "./browser-cookie-bridge-paths"
import { CMB_BROWSER_NATIVE_HOST_FLAG } from "./browser-native-messaging-host"

const execFileAsync = promisify(execFile)
const WINDOWS_NATIVE_HOST_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CMB_CHROME_NATIVE_HOST_NAME}`
const WINDOWS_NATIVE_HOST_WRAPPER_NAME = "cmb-browser-native-host.cmd"

interface NativeHostManifest {
  allowed_origins: string[]
  description: string
  name: string
  path: string
  type: "stdio"
}

export function getCmbChromeNativeHostManifestPath(): string {
  return join(getBrowserCookieBridgeDirectory(), `${CMB_CHROME_NATIVE_HOST_NAME}.json`)
}

export function getCmbChromeNativeHostWrapperPath(): string {
  return join(getBrowserCookieBridgeDirectory(), WINDOWS_NATIVE_HOST_WRAPPER_NAME)
}

function nativeHostEntryPath(): string {
  return join(app.getAppPath(), "out", "main", "browser-native-host.js")
}

function batchQuotedPath(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error("Native host path contains unsupported characters")
  return `"${value.replace(/%/g, "%%")}"`
}

export function createWindowsNativeHostWrapper(execPath: string, entryPath: string): string {
  return [
    "@echo off",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `${batchQuotedPath(execPath)} ${batchQuotedPath(entryPath)} ${CMB_BROWSER_NATIVE_HOST_FLAG} %*`,
    "endlocal",
    ""
  ].join("\r\n")
}

function expectedManifest(wrapperPath = getCmbChromeNativeHostWrapperPath()): NativeHostManifest {
  return {
    allowed_origins: [CMB_CHROME_EXTENSION_ORIGIN],
    description: "CmbCoworkAgent Chrome cookie import host",
    name: CMB_CHROME_NATIVE_HOST_NAME,
    path: wrapperPath,
    type: "stdio"
  }
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if ((await readFile(filePath, "utf8")) === content) return
  } catch {
    // Missing or unreadable files are repaired below.
  }
  await writeFile(filePath, content, "utf8")
}

async function manifestMatches(filePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as NativeHostManifest
    const expected = expectedManifest()
    return (
      parsed.name === expected.name &&
      parsed.path === expected.path &&
      parsed.type === "stdio" &&
      Array.isArray(parsed.allowed_origins) &&
      parsed.allowed_origins.includes(CMB_CHROME_EXTENSION_ORIGIN)
    )
  } catch {
    return false
  }
}

async function nativeHostFilesMatch(wrapperPath: string): Promise<boolean> {
  try {
    const entryPath = nativeHostEntryPath()
    await access(entryPath)
    return (
      (await readFile(wrapperPath, "utf8")) ===
      createWindowsNativeHostWrapper(process.execPath, entryPath)
    )
  } catch {
    return false
  }
}

async function registryMatches(manifestPath: string): Promise<boolean> {
  if (process.platform !== "win32") return false
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", WINDOWS_NATIVE_HOST_REGISTRY_KEY, "/ve"],
      { encoding: "utf8", windowsHide: true }
    )
    return String(stdout).toLowerCase().includes(manifestPath.toLowerCase())
  } catch {
    return false
  }
}

export async function ensureCmbChromeNativeHostRegistration(): Promise<BrowserCookieBridgeStatus> {
  if (process.platform !== "win32") {
    return {
      connected: false,
      error: "CmbCoworkAgent Chrome Cookie 导入目前仅支持 Windows",
      extensionId: CMB_CHROME_EXTENSION_ID,
      nativeHostRegistered: false,
      platformSupported: false
    }
  }
  if (!app.isPackaged) {
    return {
      connected: false,
      error: "Chrome Native Messaging Host 需要使用 Windows 打包版 CmbCoworkAgent 验证",
      extensionId: CMB_CHROME_EXTENSION_ID,
      nativeHostRegistered: false,
      platformSupported: true
    }
  }

  const manifestPath = getCmbChromeNativeHostManifestPath()
  const wrapperPath = getCmbChromeNativeHostWrapperPath()
  try {
    getBrowserCookieBridgeSecret()
    await mkdir(getBrowserCookieBridgeDirectory(), { recursive: true })
    await writeFileIfChanged(
      wrapperPath,
      createWindowsNativeHostWrapper(process.execPath, nativeHostEntryPath())
    )
    await writeFileIfChanged(
      manifestPath,
      `${JSON.stringify(expectedManifest(wrapperPath), null, 2)}\n`
    )
    await execFileAsync(
      "reg.exe",
      ["add", WINDOWS_NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
      { encoding: "utf8", windowsHide: true }
    )
    const registered =
      (await manifestMatches(manifestPath)) &&
      (await nativeHostFilesMatch(wrapperPath)) &&
      (await registryMatches(manifestPath))
    return {
      connected: false,
      extensionId: CMB_CHROME_EXTENSION_ID,
      nativeHostRegistered: registered,
      platformSupported: true,
      ...(!registered ? { error: "Chrome Native Messaging Host 注册验证失败" } : {})
    }
  } catch (error) {
    return {
      connected: false,
      error: `Chrome Native Messaging Host 注册失败：${error instanceof Error ? error.message : String(error)}`,
      extensionId: CMB_CHROME_EXTENSION_ID,
      nativeHostRegistered: false,
      platformSupported: true
    }
  }
}

export async function getCmbChromeNativeHostRegistrationStatus(): Promise<BrowserCookieBridgeStatus> {
  if (process.platform !== "win32") {
    return {
      connected: false,
      extensionId: CMB_CHROME_EXTENSION_ID,
      nativeHostRegistered: false,
      platformSupported: false
    }
  }
  const manifestPath = getCmbChromeNativeHostManifestPath()
  const wrapperPath = getCmbChromeNativeHostWrapperPath()
  const registered =
    app.isPackaged &&
    (await manifestMatches(manifestPath)) &&
    (await nativeHostFilesMatch(wrapperPath)) &&
    (await registryMatches(manifestPath))
  return {
    connected: false,
    extensionId: CMB_CHROME_EXTENSION_ID,
    nativeHostRegistered: registered,
    platformSupported: true
  }
}
