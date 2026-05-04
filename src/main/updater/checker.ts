import { app } from "electron"
import http from "http"
import https from "https"

export interface AsarInfo {
  file: string
  sha256: string
  size: number
}

export interface RollbackInfo {
  version: string
  file: string
  sha256: string
}

export interface PlatformInfo {
  full?: AsarInfo
  rollback?: RollbackInfo
}

export interface LatestJson {
  version: string
  minVersion: string
  releaseNotes: string
  mandatory: boolean
  asar: AsarInfo
  /** Top-level full — backward compatible, used when platforms is absent */
  full?: AsarInfo
  rollback?: RollbackInfo
  /** Per-platform overrides (win32 / linux). Takes priority over top-level full. */
  platforms?: Record<string, PlatformInfo>
}

export type UpdateType = "asar" | "full"

export interface UpdateCheckResult {
  version: string
  updateType: UpdateType
  releaseNotes: string
  mandatory: boolean
  downloadFile: string
  downloadSha256: string
  downloadSize: number
  rollback?: RollbackInfo
}

/**
 * Compare two semver strings. Returns:
 *  -1 if a < b, 0 if a === b, 1 if a > b
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}

/**
 * Determine update type by comparing version numbers.
 * Only patch-level changes use ASAR replacement; everything else uses full installer.
 */
function determineUpdateType(currentVersion: string, newVersion: string, minVersion: string): UpdateType {
  // If current version is below minVersion, force full update
  if (compareSemver(currentVersion, minVersion) < 0) {
    return "full"
  }

  const cur = currentVersion.split(".").map(Number)
  const next = newVersion.split(".").map(Number)

  // Only patch changed (major and minor are the same) → ASAR
  if (cur[0] === next[0] && cur[1] === next[1]) {
    return "asar"
  }

  return "full"
}

/**
 * Fetch latest.json from the update server.
 */
export function fetchLatestJson(baseUrl: string): Promise<LatestJson> {
  const url = new URL(`${baseUrl}/download`)
  url.searchParams.set("file", "cmbdevclaw-latest.json")
  const urlStr = url.toString()
  console.log("[Updater] Fetching:", urlStr)

  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith("https") ? https : http
    const req = client.request(urlStr, { method: "POST", timeout: 10000 }, (res) => {
      console.log("[Updater] Response status:", res.statusCode)
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching latest.json`))
        res.resume()
        return
      }

      let data = ""
      res.on("data", (chunk: Buffer) => { data += chunk.toString() })
      res.on("end", () => {
        try {
          const json = JSON.parse(data) as LatestJson
          resolve(json)
        } catch (e) {
          reject(new Error("Failed to parse latest.json"))
        }
      })
    })

    req.on("error", reject)
    req.on("timeout", () => {
      req.destroy()
      reject(new Error("Timeout fetching latest.json"))
    })

    req.end()
  })
}

/**
 * Check for updates against the remote server.
 * Returns null if no update is available.
 */
export async function checkForUpdate(baseUrl: string): Promise<UpdateCheckResult | null> {
  const latest = await fetchLatestJson(baseUrl)
  const currentVersion = app.getVersion()

  if (compareSemver(currentVersion, latest.version) >= 0) {
    return null // already up to date
  }

  const updateType = determineUpdateType(currentVersion, latest.version, latest.minVersion)

  // Resolve platform-specific overrides: platforms[platform] > top-level
  const platform = process.platform // "win32" | "linux" | "darwin"
  const platformInfo = latest.platforms?.[platform]

  let downloadFile: string
  let downloadSha256: string
  let downloadSize: number

  if (updateType === "asar") {
    downloadFile = latest.asar.file
    downloadSha256 = latest.asar.sha256
    downloadSize = latest.asar.size
  } else {
    // Priority: platforms[platform].full → top-level full → fallback to asar
    const fullInfo = platformInfo?.full ?? latest.full
    if (!fullInfo) {
      downloadFile = latest.asar.file
      downloadSha256 = latest.asar.sha256
      downloadSize = latest.asar.size
    } else {
      downloadFile = fullInfo.file
      downloadSha256 = fullInfo.sha256
      downloadSize = fullInfo.size
    }
  }

  // Rollback: platforms[platform].rollback → top-level rollback
  const rollback = platformInfo?.rollback ?? latest.rollback

  return {
    version: latest.version,
    updateType,
    releaseNotes: latest.releaseNotes,
    mandatory: latest.mandatory,
    downloadFile,
    downloadSha256,
    downloadSize,
    rollback
  }
}
