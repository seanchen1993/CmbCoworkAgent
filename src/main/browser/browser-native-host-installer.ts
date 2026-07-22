import { execFile } from "child_process"
import { mkdir, readFile, writeFile } from "fs/promises"
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

const execFileAsync = promisify(execFile)
const WINDOWS_NATIVE_HOST_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CMB_CHROME_NATIVE_HOST_NAME}`

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

function expectedManifest(): NativeHostManifest {
  return {
    allowed_origins: [CMB_CHROME_EXTENSION_ORIGIN],
    description: "CmbCoworkAgent Chrome cookie import host",
    name: CMB_CHROME_NATIVE_HOST_NAME,
    path: process.execPath,
    type: "stdio"
  }
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
  try {
    getBrowserCookieBridgeSecret()
    await mkdir(getBrowserCookieBridgeDirectory(), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(expectedManifest(), null, 2)}\n`, "utf8")
    await execFileAsync(
      "reg.exe",
      ["add", WINDOWS_NATIVE_HOST_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
      { encoding: "utf8", windowsHide: true }
    )
    const registered =
      (await manifestMatches(manifestPath)) && (await registryMatches(manifestPath))
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
  const registered =
    app.isPackaged &&
    (await manifestMatches(manifestPath)) &&
    (await registryMatches(manifestPath))
  return {
    connected: false,
    extensionId: CMB_CHROME_EXTENSION_ID,
    nativeHostRegistered: registered,
    platformSupported: true
  }
}
