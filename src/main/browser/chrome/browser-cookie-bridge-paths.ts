import { createHash, randomBytes } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

const BRIDGE_DIRECTORY = join(homedir(), ".cmbcoworkagent", "browser-native-host")
const BRIDGE_SECRET_FILE = join(BRIDGE_DIRECTORY, "bridge-secret")

export function getBrowserCookieBridgeDirectory(): string {
  return BRIDGE_DIRECTORY
}

export function getBrowserCookieBridgeSecret(): string {
  let replaceInvalidSecret = false
  if (existsSync(BRIDGE_SECRET_FILE)) {
    const existing = readFileSync(BRIDGE_SECRET_FILE, "utf8").trim()
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing
    replaceInvalidSecret = true
  }

  mkdirSync(BRIDGE_DIRECTORY, { recursive: true, mode: 0o700 })
  const secret = randomBytes(32).toString("hex")
  if (replaceInvalidSecret) {
    writeFileSync(BRIDGE_SECRET_FILE, `${secret}\n`, { encoding: "utf8", mode: 0o600 })
    return secret
  }
  try {
    writeFileSync(BRIDGE_SECRET_FILE, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    })
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const existing = readFileSync(BRIDGE_SECRET_FILE, "utf8").trim()
    if (/^[a-f0-9]{64}$/i.test(existing)) return existing
    throw new Error("Browser Cookie bridge secret is invalid")
  }
}

export function getBrowserCookieBridgePipePath(
  platform: NodeJS.Platform = process.platform
): string {
  const userKey = createHash("sha256").update(homedir()).digest("hex").slice(0, 16)
  if (platform === "win32") {
    return `\\\\.\\pipe\\cmbcoworkagent-browser-cookie-${userKey}`
  }
  return join(tmpdir(), `cmbcoworkagent-browser-cookie-${userKey}.sock`)
}
