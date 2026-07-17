import { compareSemver } from "./semver"

export interface UpdateMarker {
  fromVersion: string
  /** Actual version expected after this install step. */
  toVersion: string
  /** Final channel target when this is an intermediate full install. */
  releaseVersion?: string
  /** Channel selected before the intermediate full update was installed. */
  channel?: "stable" | "staging"
  /** Global ASAR compatibility floor used when the chain was selected. */
  minVersion?: string
  updatedAt?: string
  updateType?: string
}

function isSameMajorMinor(a: string, b: string): boolean {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  return left[0] === right[0] && left[1] === right[1]
}

/**
 * Whether an installed intermediate version can finish at targetVersion with
 * one ASAR update under the supplied global compatibility floor.
 */
export function canCompleteWithAsar(
  currentVersion: string,
  targetVersion: string,
  minVersion: string
): boolean {
  return (
    compareSemver(currentVersion, minVersion) >= 0 &&
    compareSemver(currentVersion, targetVersion) < 0 &&
    isSameMajorMinor(currentVersion, targetVersion)
  )
}

/**
 * A legacy full marker whose version mismatch may be an intermediate install.
 * This is only a candidate: without the manifest minVersion it must not be
 * treated as a successful chained update.
 */
export function isLegacyIntermediateFullCandidate(
  marker: UpdateMarker,
  currentVersion: string
): boolean {
  if (marker.updateType !== "full" || marker.releaseVersion !== undefined) return false
  if (compareSemver(currentVersion, marker.fromVersion) <= 0) return false
  if (compareSemver(currentVersion, marker.toVersion) >= 0) return false
  return isSameMajorMinor(currentVersion, marker.toVersion)
}

/**
 * Full packages produced before chained-update support wrote the final release
 * version into `toVersion`, because the marker had no separate package version.
 * A rebuilt intermediate package can recognize that legacy marker and safely
 * continue when it made monotonic progress and can finish with one ASAR step.
 */
export function isLegacyIntermediateFullUpdate(
  marker: UpdateMarker,
  currentVersion: string,
  minVersion: string
): boolean {
  return (
    isLegacyIntermediateFullCandidate(marker, currentVersion) &&
    canCompleteWithAsar(currentVersion, marker.toVersion, minVersion)
  )
}
