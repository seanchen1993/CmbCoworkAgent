import { mkdirSync, unlinkSync, writeFileSync } from "fs"
import { mkdir } from "fs/promises"
import { tmpdir } from "os"
import path from "path"

export type BrowserNativePipeKind = "windows-named-pipe" | "unix-domain-socket" | "unknown"

const OFFICIAL_BROWSER_USE_PIPE_BASENAME = "codex-browser-use"
const BROWSER_IAB_PIPE_MARKER_PREFIX = "cmb-iab"

export function getBrowserRuntimeTmpDir(): string {
  return path.join(tmpdir(), "cmbdevclaw-browser-runtime")
}

export async function ensureBrowserRuntimeTmpDir(): Promise<string> {
  const dir = getBrowserRuntimeTmpDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export function getBrowserRuntimeImageDir(): string {
  return path.join(getBrowserRuntimeTmpDir(), "images")
}

export async function ensureBrowserRuntimeImageDir(): Promise<string> {
  const dir = getBrowserRuntimeImageDir()
  await mkdir(dir, { recursive: true })
  return dir
}

export function getNativePipeKind(pipePath: string): BrowserNativePipeKind {
  if (/^\\\\\.\\pipe\\/.test(pipePath)) return "windows-named-pipe"
  if (path.isAbsolute(pipePath)) return "unix-domain-socket"
  return "unknown"
}

export function isSupportedNativePipePath(pipePath: string): boolean {
  return getNativePipeKind(pipePath) !== "unknown"
}

export function getOfficialBrowserUsePipeBasePath(
  targetPlatform: NodeJS.Platform = process.platform
): string {
  if (targetPlatform === "win32") return "\\\\.\\pipe\\codex-browser-use"

  // The official browser-client.mjs discovers Unix backends from this exact base path.
  return path.join(path.sep, "tmp", OFFICIAL_BROWSER_USE_PIPE_BASENAME)
}

export function isOfficialBrowserUsePipePath(
  pipePath: string,
  targetPlatform: NodeJS.Platform = process.platform
): boolean {
  const basePath = getOfficialBrowserUsePipeBasePath(targetPlatform)
  if (targetPlatform === "win32") return pipePath.startsWith(`${basePath}-`)
  return pipePath.startsWith(`${basePath}${path.sep}`)
}

function sanitizeBrowserPipePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 96) || "default"
}

export function getOfficialBrowserUseIabPipePath(
  sessionId: string,
  targetPlatform: NodeJS.Platform = process.platform
): string {
  const pipeName = `${BROWSER_IAB_PIPE_MARKER_PREFIX}-${process.pid}-${sanitizeBrowserPipePathPart(
    sessionId
  )}`
  const basePath = getOfficialBrowserUsePipeBasePath(targetPlatform)
  if (targetPlatform === "win32") return `${basePath}-${pipeName}`
  return path.join(basePath, `${pipeName}.sock`)
}

export function ensureOfficialBrowserUsePipeDiscoveryPathSync(
  pipePath: string,
  targetPlatform: NodeJS.Platform = process.platform
): void {
  if (targetPlatform === "win32") return
  mkdirSync(path.dirname(pipePath), { recursive: true })
  writeFileSync(pipePath, "cmb-iab\n", "utf8")
}

export function removeOfficialBrowserUsePipeDiscoveryPathSync(
  pipePath: string,
  targetPlatform: NodeJS.Platform = process.platform
): void {
  if (targetPlatform === "win32") return
  try {
    unlinkSync(pipePath)
  } catch {
    // Best-effort cleanup only; stale markers are ignored by backend discovery.
  }
}
