import { appendFileSync, mkdirSync } from "fs"
import {
  getBrowserCookieBridgeDirectory,
  getBrowserCookieBridgeNativeHostLogPath
} from "./browser-cookie-bridge-paths"

const TAG = "[CmbBrowserNativeHost]"

function formatLine(message: string): string {
  return `[${new Date().toISOString()}] ${TAG} ${message}\n`
}

export function writeBrowserNativeHostLog(message: string): void {
  const line = formatLine(message)
  try {
    process.stderr.write(line)
  } catch {
    // Best effort only.
  }
  try {
    mkdirSync(getBrowserCookieBridgeDirectory(), { recursive: true, mode: 0o700 })
    appendFileSync(getBrowserCookieBridgeNativeHostLogPath(), line, { encoding: "utf8" })
  } catch {
    // Best effort only.
  }
}
