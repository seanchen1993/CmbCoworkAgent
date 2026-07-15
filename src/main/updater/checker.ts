import { app } from "electron"
import http from "http"
import https from "https"
import { getUserInfo, type UserInfoConfig } from "../storage"
import type { FeatureGatesConfig } from "../../shared/feature-gates"
import { evaluateStaging } from "./gray-release"
import { compareSemver } from "./semver"
import { DEFAULT_UPDATE_MANIFEST_FILE } from "./channel-config"
import {
  clearPendingUpdateChain,
  readLegacyUpdateMarker,
  readPendingUpdateChain,
  type PendingUpdateChain
} from "./update-chain"
import { canCompleteWithAsar, isLegacyIntermediateFullUpdate } from "./update-marker"

export { compareSemver }

export interface AsarInfo {
  /**
   * Actual version contained in this package. When omitted, the channel's
   * target version is used for backward compatibility.
   *
   * This is primarily useful for a full package that bootstraps an older
   * client to the minimum ASAR-capable version before it receives the final
   * patch update.
   */
  version?: string
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

/**
 * Gray-release (staging) channel block. When present in latest.json, eligible
 * clients receive this version instead of the stable top-level one. The shape
 * mirrors the top-level manifest (asar/full/platforms/rollback) so the same
 * download/install path can be reused. See docs/updater-gray-release.md.
 */
export interface StagingBlock {
  version: string
  releaseNotes?: string
  asar?: AsarInfo
  full?: AsarInfo
  rollback?: RollbackInfo
  platforms?: Record<string, PlatformInfo>

  /** 0~100. 0 disables percentage rollout (whitelists still apply); 100 means everyone hits. */
  rolloutPercent: number
  /** Bucketing seed. Changing it reshuffles all clients. Defaults to staging.version when absent. */
  rolloutSeed?: string

  /** Force-hit by ystId or sapId. */
  whitelistUsers?: string[]
  /** Force-miss; beats every whitelist. */
  blacklistUsers?: string[]
  /** Force-hit by userInfo.originOrgId. */
  whitelistOrgs?: string[]
  /** Force-hit by userInfo.pathName prefix (e.g. "总行/信息技术部"). */
  whitelistPaths?: string[]

  /** Whether logged-out users participate. Default false. */
  includeAnonymous?: boolean
  /** Clients below this version do not participate (they need a stable upgrade first). */
  minVersion?: string
  /** ISO datetime. After this all users fall back to stable, regardless of other rules. */
  expireAt?: string
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
  /** Optional gray-release block. See StagingBlock. */
  staging?: StagingBlock
  /** Optional app feature gates. Independent from updater gray-release staging. */
  featureGates?: FeatureGatesConfig
}

export type UpdateType = "asar" | "full"
export type UpdateChannel = "stable" | "staging"

export interface UpdateCheckResult {
  /** Actual version installed by this update step. */
  version: string
  /** Final version advertised by the selected stable/staging channel. */
  targetVersion: string
  /** Global compatibility floor used to select this update step. */
  minVersion: string
  updateType: UpdateType
  releaseNotes: string
  mandatory: boolean
  downloadFile: string
  downloadSha256: string
  downloadSize: number
  rollback?: RollbackInfo
  /** Which channel produced this result. Drives anti-flip-flop logic in update:install. */
  channel: UpdateChannel
  /** Stable, machine-readable explanation of the channel decision (for logs / about page). */
  grayReason: string
}

/**
 * Determine update type by comparing version numbers.
 * Only patch-level changes use ASAR replacement; everything else uses full installer.
 */
function determineUpdateType(
  currentVersion: string,
  newVersion: string,
  minVersion: string
): UpdateType {
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
export function fetchLatestJson(
  baseUrl: string,
  manifestFile: string = DEFAULT_UPDATE_MANIFEST_FILE
): Promise<LatestJson> {
  const url = new URL(`${baseUrl}/download`)
  url.searchParams.set("file", manifestFile)
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
      res.on("data", (chunk: Buffer) => {
        data += chunk.toString()
      })
      res.on("end", () => {
        try {
          const json = JSON.parse(data) as LatestJson
          resolve(json)
        } catch {
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

interface ResolvedDownload {
  /** Actual version expected after installing the selected package. */
  version: string
  updateType: UpdateType
  downloadFile: string
  downloadSha256: string
  downloadSize: number
  rollback?: RollbackInfo
}

/**
 * Given a channel manifest (top-level stable block or staging block), produce
 * the concrete download descriptor for the current platform.
 *
 * topLevelMinVersion is always sourced from the stable block — staging never
 * gets to relax the global minVersion floor.
 */
function resolveDownload(
  currentVersion: string,
  targetVersion: string,
  topLevelMinVersion: string,
  asar: AsarInfo | undefined,
  full: AsarInfo | undefined,
  platforms: Record<string, PlatformInfo> | undefined,
  rollback: RollbackInfo | undefined,
  platform: NodeJS.Platform
): ResolvedDownload {
  const updateType = determineUpdateType(currentVersion, targetVersion, topLevelMinVersion)
  const platformInfo = platforms?.[platform]

  let downloadFile: string
  let downloadSha256: string
  let downloadSize: number
  let packageVersion: string

  if (updateType === "asar") {
    if (!asar) {
      throw new Error(`当前为补丁更新，但 manifest 未提供 asar 包`)
    }
    downloadFile = asar.file
    downloadSha256 = asar.sha256
    downloadSize = asar.size
    packageVersion = asar.version ?? targetVersion

    // A channel exposes only one ASAR payload. Allowing that payload to lag
    // behind the channel target would select the same already-installed file
    // again on the next check and create an update loop.
    if (compareSemver(packageVersion, targetVersion) !== 0) {
      throw new Error(`asar 包版本 ${packageVersion} 必须与目标版本 ${targetVersion} 一致`)
    }
  } else {
    const fullInfo = platformInfo?.full ?? full
    if (!fullInfo) {
      throw new Error(`当前版本需要完整更新，但服务器未提供 ${platform} 的完整更新包`)
    }
    downloadFile = fullInfo.file
    downloadSha256 = fullInfo.sha256
    downloadSize = fullInfo.size
    packageVersion = fullInfo.version ?? targetVersion

    if (compareSemver(packageVersion, currentVersion) <= 0) {
      throw new Error(`full 包版本 ${packageVersion} 必须高于当前版本 ${currentVersion}`)
    }
    if (compareSemver(packageVersion, targetVersion) > 0) {
      throw new Error(`full 包版本 ${packageVersion} 不能高于目标版本 ${targetVersion}`)
    }
    if (
      compareSemver(packageVersion, targetVersion) < 0 &&
      determineUpdateType(packageVersion, targetVersion, topLevelMinVersion) !== "asar"
    ) {
      throw new Error(
        `full 包版本 ${packageVersion} 安装后无法通过 asar 升级到目标版本 ${targetVersion}`
      )
    }
  }

  return {
    version: packageVersion,
    updateType,
    downloadFile,
    downloadSha256,
    downloadSize,
    rollback: platformInfo?.rollback ?? rollback
  }
}

/**
 * Read userInfo without ever letting a corrupted file break the updater.
 * A bad ~/.config user-info json must not strand users on an outdated build —
 * the stable channel path doesn't need user info at all.
 */
function safeGetUserInfo(): ReturnType<typeof getUserInfo> {
  try {
    return getUserInfo()
  } catch (err) {
    console.warn("[Updater] getUserInfo() failed, treating as anonymous:", err)
    return null
  }
}

/**
 * Pure channel selection: given the fetched manifest and the runtime context
 * (current version, user info, platform), decide which update to deliver.
 *
 * Exported separately from `checkForUpdate` so it can be unit-tested without
 * mocking electron / network / fs.
 *
 * Channel precedence:
 *   1. If stable is mandatory → always stable (gray cohort must not be exempt from forced upgrades).
 *   2. If staging.version <= stable.version → staging is stale, ignore it (stable has caught up or surpassed).
 *   3. If user is staging-hit AND staging download info resolves cleanly → staging.
 *   4. Otherwise → stable.
 *
 * A staging block that fails to resolve (missing asar/full for the current
 * platform) falls back to stable rather than stranding the user with "no
 * update" — a half-broken staging block must never block the stable channel.
 */
export function selectChannelTarget(
  latest: LatestJson,
  currentVersion: string,
  userInfo: UserInfoConfig | null,
  platform: NodeJS.Platform,
  pendingChain: PendingUpdateChain | null = null
): UpdateCheckResult | null {
  const decision = evaluateStaging({
    userInfo,
    currentVersion,
    staging: latest.staging
  })

  const stagingViable =
    !!latest.staging &&
    !latest.mandatory &&
    compareSemver(latest.staging.version, latest.version) > 0

  // Once an intermediate full package has been installed, cohort membership
  // must be sticky for the final ASAR step. Re-bucketing, logout, or an account
  // switch must not strand the client. Global safety controls still win:
  // deleting/expiring staging, raising a minVersion above the intermediate,
  // or publishing a mandatory stable update all disable continuation.
  const continuingStagingChain =
    !!latest.staging &&
    pendingChain?.channel === "staging" &&
    pendingChain.intermediateVersion === currentVersion &&
    pendingChain.targetVersion === latest.staging.version &&
    canCompleteWithAsar(currentVersion, latest.staging.version, latest.minVersion) &&
    (!latest.staging.minVersion || compareSemver(currentVersion, latest.staging.minVersion) >= 0) &&
    decision.reason !== "staging-expired"

  if ((decision.hit || continuingStagingChain) && stagingViable && latest.staging) {
    const staging = latest.staging
    if (compareSemver(currentVersion, staging.version) < 0) {
      try {
        const resolved = resolveDownload(
          currentVersion,
          staging.version,
          latest.minVersion,
          staging.asar,
          staging.full,
          staging.platforms,
          staging.rollback,
          platform
        )
        const grayReason = continuingStagingChain ? "pending-chain" : decision.reason
        console.log(
          `[Updater] Staging hit: v${staging.version} reason=${grayReason}` +
            (decision.bucketKey ? ` user=${decision.bucketKey}` : "")
        )
        return {
          version: resolved.version,
          targetVersion: staging.version,
          minVersion: latest.minVersion,
          updateType: resolved.updateType,
          releaseNotes: staging.releaseNotes ?? latest.releaseNotes,
          // Staging is never mandatory — mandatory upgrades must go through the
          // stable channel so they reach everyone, not just the gray cohort.
          mandatory: false,
          downloadFile: resolved.downloadFile,
          downloadSha256: resolved.downloadSha256,
          downloadSize: resolved.downloadSize,
          rollback: resolved.rollback,
          channel: "staging",
          grayReason
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[Updater] Staging unusable, falling back to stable: ${msg}`)
        // fall through to stable
      }
    }
    // current >= staging.version: user is already on (or beyond) the staging
    // candidate. Don't return null here — stable may still have something for
    // them (e.g. a hotfix that bumped stable above staging). Fall through.
  }

  if (compareSemver(currentVersion, latest.version) >= 0) {
    return null
  }
  const resolved = resolveDownload(
    currentVersion,
    latest.version,
    latest.minVersion,
    latest.asar,
    latest.full,
    latest.platforms,
    latest.rollback,
    platform
  )
  console.log(`[Updater] Stable: v${latest.version} grayReason=${decision.reason}`)
  return {
    version: resolved.version,
    targetVersion: latest.version,
    minVersion: latest.minVersion,
    updateType: resolved.updateType,
    releaseNotes: latest.releaseNotes,
    mandatory: latest.mandatory,
    downloadFile: resolved.downloadFile,
    downloadSha256: resolved.downloadSha256,
    downloadSize: resolved.downloadSize,
    rollback: resolved.rollback,
    channel: "stable",
    grayReason: decision.reason
  }
}

function resolvePendingChain(
  latest: LatestJson,
  currentVersion: string
): PendingUpdateChain | null {
  const persisted = readPendingUpdateChain()
  if (persisted) {
    if (compareSemver(currentVersion, persisted.targetVersion) >= 0) {
      clearPendingUpdateChain()
    } else if (persisted.intermediateVersion === currentVersion) {
      return persisted
    }
  }

  const legacyMarker = readLegacyUpdateMarker()
  if (
    !legacyMarker ||
    !isLegacyIntermediateFullUpdate(legacyMarker, currentVersion, latest.minVersion)
  ) {
    return null
  }

  let channel: PendingUpdateChain["channel"] | null = null
  if (legacyMarker.toVersion === latest.version) {
    channel = "stable"
  } else if (legacyMarker.toVersion === latest.staging?.version) {
    channel = "staging"
  }
  if (!channel) return null

  return {
    intermediateVersion: currentVersion,
    targetVersion: legacyMarker.toVersion,
    channel,
    minVersion: latest.minVersion,
    createdAt: legacyMarker.updatedAt ?? "legacy-marker"
  }
}

/**
 * Check for updates against the remote server.
 * Returns null if no update is available for the current client.
 */
export async function checkForUpdate(
  baseUrl: string,
  options: { manifestFile?: string } = {}
): Promise<UpdateCheckResult | null> {
  const latest = await fetchLatestJson(baseUrl, options.manifestFile)
  const currentVersion = app.getVersion()
  return selectChannelTarget(
    latest,
    currentVersion,
    safeGetUserInfo(),
    process.platform,
    resolvePendingChain(latest, currentVersion)
  )
}
