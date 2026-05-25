import { createHash } from "crypto"
import type { UserInfoConfig } from "../storage"
import type { StagingBlock, UpdateCheckResult } from "./checker"
import { compareSemver } from "./semver"

/**
 * Equality check for an in-flight staging download against a fresh recheck.
 * Used by the install-time safety net to refuse stale local packages.
 *
 * Compares every payload-defining field: a manifest may swap the file behind
 * the same version number (sha256, file name, size, updateType, or rollback
 * descriptor change). Pure version equality would let those through.
 */
export function isSameStagingPayload(
  prev: UpdateCheckResult,
  next: UpdateCheckResult | null
): boolean {
  if (next === null) return false
  return (
    next.channel === "staging" &&
    prev.channel === "staging" &&
    next.version === prev.version &&
    next.updateType === prev.updateType &&
    next.downloadFile === prev.downloadFile &&
    next.downloadSha256 === prev.downloadSha256 &&
    next.downloadSize === prev.downloadSize &&
    isSameRollback(prev.rollback, next.rollback)
  )
}

/**
 * Field-wise rollback equality. JSON.stringify would work today (V8 preserves
 * insertion order) but is brittle: any server-side serializer or manifest
 * editor that reorders keys would falsely report "rollback changed" and
 * trigger a spurious staging-withdrawn cleanup.
 */
function isSameRollback(
  a: UpdateCheckResult["rollback"],
  b: UpdateCheckResult["rollback"]
): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return a.version === b.version && a.file === b.file && a.sha256 === b.sha256
}

export interface StagingDecisionInput {
  userInfo: UserInfoConfig | null
  currentVersion: string
  staging: StagingBlock | undefined
  now?: Date
}

export interface StagingDecision {
  hit: boolean
  reason: string
  bucketKey?: string
}

/**
 * Decide whether the current client should receive the staging (gray) update.
 *
 * Decision order (first match wins):
 *   1. No staging block / expired / below minVersion / staging.version not newer → miss
 *   2. Anonymous (no ystId & no sapId) → includeAnonymous flag
 *   3. Blacklisted user → miss
 *   4. Whitelisted by user / org / path prefix → hit
 *   5. Bucketed by sha1("<userKey>|<seed>") % 100 < rolloutPercent
 *
 * The function is pure — same inputs always produce the same decision. Reason
 * strings are stable so they can be surfaced in the UI or written to logs for
 * post-mortem analysis.
 */
export function evaluateStaging(input: StagingDecisionInput): StagingDecision {
  const { userInfo, currentVersion, staging } = input
  const now = input.now ?? new Date()

  if (!staging) return { hit: false, reason: "no-staging-block" }

  if (staging.expireAt) {
    const exp = Date.parse(staging.expireAt)
    if (!Number.isNaN(exp) && now.getTime() >= exp) {
      return { hit: false, reason: "staging-expired" }
    }
  }

  if (staging.minVersion && compareSemver(currentVersion, staging.minVersion) < 0) {
    return { hit: false, reason: "below-staging-minVersion" }
  }

  if (compareSemver(currentVersion, staging.version) >= 0) {
    return { hit: false, reason: "staging-not-newer" }
  }

  const ystId = userInfo?.ystId?.trim() ?? ""
  const sapId = userInfo?.sapId?.trim() ?? ""
  // Bucket key has fixed priority (ystId > sapId) so the same user maps to the
  // same bucket forever, regardless of which ID ops chose to put in the list.
  const userKey = ystId || sapId
  if (!userKey) {
    return {
      hit: staging.includeAnonymous === true,
      reason: staging.includeAnonymous ? "anonymous-included" : "anonymous-excluded"
    }
  }

  // Name matching, however, accepts EITHER id — ops should be able to ship a
  // blacklist of sapIds without it silently no-op'ing on users that also have a
  // ystId. Empty strings are filtered so a missing id can never accidentally
  // match an entry that itself is "".
  const idsForMatch = [ystId, sapId].filter((v) => v.length > 0)
  const matchesAny = (list: string[] | undefined): boolean =>
    !!list && list.some((entry) => idsForMatch.includes(entry))

  if (matchesAny(staging.blacklistUsers)) {
    return { hit: false, reason: "blacklisted", bucketKey: userKey }
  }

  if (matchesAny(staging.whitelistUsers)) {
    return { hit: true, reason: "whitelist-user", bucketKey: userKey }
  }

  const orgId = userInfo?.originOrgId?.trim()
  if (orgId && staging.whitelistOrgs?.includes(orgId)) {
    return { hit: true, reason: "whitelist-org", bucketKey: userKey }
  }

  const pathName = userInfo?.pathName?.trim()
  if (pathName && staging.whitelistPaths?.some((p) => isPathPrefixMatch(pathName, p))) {
    return { hit: true, reason: "whitelist-path", bucketKey: userKey }
  }

  const pctRaw = staging.rolloutPercent
  const pct = typeof pctRaw === "number" ? Math.max(0, Math.min(100, Math.floor(pctRaw))) : 0
  if (pct <= 0) return { hit: false, reason: "rollout-0", bucketKey: userKey }
  if (pct >= 100) return { hit: true, reason: "rollout-100", bucketKey: userKey }

  const seed = staging.rolloutSeed || staging.version
  const hash = createHash("sha1").update(`${userKey}|${seed}`).digest()
  const bucket = hash.readUInt32BE(0) % 100
  return {
    hit: bucket < pct,
    reason: `bucket=${bucket}/${pct}`,
    bucketKey: userKey
  }
}

/**
 * Path-segment-aware prefix match. A bare `startsWith` would let an entry
 * "总行/信息技术部" match "总行/信息技术部外包组" — a sibling org, not a child.
 * We accept either an exact match or a child match where the next character
 * is a path separator.
 */
function isPathPrefixMatch(pathName: string, prefix: string): boolean {
  if (!prefix) return false
  // Strip a trailing slash on the prefix so ops can write either
  // "总行/信息技术部" or "总行/信息技术部/" and get the same behavior.
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix
  if (pathName === normalized) return true
  return pathName.startsWith(normalized + "/")
}
