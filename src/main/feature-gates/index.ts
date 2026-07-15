import { getUserInfo, type UserInfoConfig } from "../storage"
import { fetchLatestJson, type LatestJson } from "../updater/checker"
import { matchUserTargeting } from "../updater/gray-release"
import type {
  FeatureGateCheckOptions,
  FeatureGateCheckResult,
  FeatureGateConfig,
  FeatureGatesConfig,
  FeatureGateKey
} from "../../shared/feature-gates"

const FEATURE_GATE_MANIFEST_TTL_MS = 6 * 60 * 60 * 1000

let manifestCache: { baseUrl: string; fetchedAt: number; manifest: LatestJson } | null = null
let manifestRequest: Promise<LatestJson> | null = null
let startupPrefetchTimer: ReturnType<typeof setTimeout> | null = null

function getUpdateServerUrl(): string {
  const url = (import.meta.env.VITE_UPDATE_SERVER_URL as string) || ""
  if (!url) {
    console.warn("[FeatureGates] VITE_UPDATE_SERVER_URL is not configured")
  }
  return url
}

function safeGetUserInfo(): UserInfoConfig | null {
  try {
    return getUserInfo()
  } catch (err) {
    console.warn("[FeatureGates] getUserInfo() failed, treating as anonymous:", err)
    return null
  }
}

async function getFeatureGateManifest(
  baseUrl: string,
  forceRefresh: boolean,
  reason = forceRefresh ? "force-refresh" : "feature-check"
): Promise<LatestJson | null> {
  const now = Date.now()
  if (
    !forceRefresh &&
    manifestCache &&
    manifestCache.baseUrl === baseUrl &&
    now - manifestCache.fetchedAt < FEATURE_GATE_MANIFEST_TTL_MS
  ) {
    return manifestCache.manifest
  }

  if (!forceRefresh && manifestRequest) {
    try {
      return await manifestRequest
    } catch {
      return null
    }
  }

  const startedAt = Date.now()
  console.log(
    `[FeatureGates] Fetching remote config: reason=${reason} force=${forceRefresh} baseUrl=${baseUrl}`
  )
  const request = fetchLatestJson(baseUrl)
  if (!forceRefresh) {
    manifestRequest = request
  }

  try {
    const manifest = await request
    manifestCache = { baseUrl, fetchedAt: Date.now(), manifest }
    const featureNames = Object.keys(manifest.featureGates ?? {})
    console.log(
      `[FeatureGates] Remote config fetched: reason=${reason} version=${manifest.version} ` +
        `hasFeatureGates=${manifest.featureGates ? "true" : "false"} ` +
        `features=${featureNames.length > 0 ? featureNames.join(",") : "-"} ` +
        `durationMs=${Date.now() - startedAt}`
    )
    return manifest
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(
      `[FeatureGates] Failed to fetch feature gate config: reason=${reason} ` +
        `durationMs=${Date.now() - startedAt} message=${message}`,
      err
    )
    return null
  } finally {
    if (manifestRequest === request) {
      manifestRequest = null
    }
  }
}

async function refreshFeatureGateManifest(): Promise<void> {
  const baseUrl = getUpdateServerUrl()
  if (!baseUrl) return
  await getFeatureGateManifest(baseUrl, false, "startup-prefetch")
}

export function startFeatureGatePrefetch(delayMs = 3000): void {
  if (startupPrefetchTimer) return
  startupPrefetchTimer = setTimeout(() => {
    startupPrefetchTimer = null
    void refreshFeatureGateManifest()
  }, delayMs)
  console.log(`[FeatureGates] Startup config prefetch scheduled in ${delayMs}ms`)
}

export function stopFeatureGatePrefetch(): void {
  if (!startupPrefetchTimer) return
  clearTimeout(startupPrefetchTimer)
  startupPrefetchTimer = null
}

function isExpired(expireAt: string | undefined, now: Date): boolean {
  if (!expireAt) return false
  const exp = Date.parse(expireAt)
  return !Number.isNaN(exp) && now.getTime() >= exp
}

export function evaluateFeatureGate(
  name: FeatureGateKey,
  featureGates: FeatureGatesConfig | undefined,
  userInfo: UserInfoConfig | null,
  now = new Date()
): FeatureGateCheckResult {
  const gate: FeatureGateConfig | undefined = featureGates?.[name]
  if (!gate) return { enabled: false, reason: "feature-gate-missing" }
  if (gate.enabled !== true) return { enabled: false, reason: "feature-gate-disabled" }
  if (isExpired(gate.expireAt, now)) return { enabled: false, reason: "feature-gate-expired" }

  const decision = matchUserTargeting(userInfo, {
    blacklistUsers: gate.blacklistUsers,
    whitelistUsers: gate.whitelistUsers,
    whitelistOrgs: gate.whitelistOrgs,
    whitelistPaths: gate.whitelistPaths,
    rolloutPercent: gate.rolloutPercent ?? 0,
    rolloutSeed: gate.rolloutSeed || name,
    includeAnonymous: gate.includeAnonymous
  })

  return {
    enabled: decision.hit,
    reason: decision.reason
  }
}

export async function isFeatureGateEnabled(
  name: FeatureGateKey,
  options: FeatureGateCheckOptions = {}
): Promise<FeatureGateCheckResult> {
  // TODO(temporary): 本地 dev 没有配置 VITE_UPDATE_SERVER_URL，远程 feature gate 拉不到，
  // 导致项目模式等开关本地用不了。dev 模式下临时全部放开，发布前移除。
  if (import.meta.env.DEV) {
    return { enabled: true, reason: "dev-mode-override" }
  }

  const baseUrl = getUpdateServerUrl()
  if (!baseUrl) return { enabled: false, reason: "update-server-url-missing" }

  const manifest = await getFeatureGateManifest(
    baseUrl,
    options.refresh === true,
    options.refresh === true ? `force-refresh:${name}` : `feature-check:${name}`
  )
  if (!manifest) return { enabled: false, reason: "feature-gate-config-unavailable" }

  return evaluateFeatureGate(name, manifest.featureGates, safeGetUserInfo())
}
