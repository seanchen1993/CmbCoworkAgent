import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import { getUpdatesDir } from "./downloader"
import type { UpdateMarker } from "./update-marker"

export interface PendingUpdateChain {
  intermediateVersion: string
  targetVersion: string
  channel: "stable" | "staging"
  minVersion: string
  createdAt: string
}

function getPendingUpdateChainPath(): string {
  return join(getUpdatesDir(), "pending-update-chain.json")
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

export function parsePendingUpdateChain(value: unknown): PendingUpdateChain | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<PendingUpdateChain>
  if (!isNonEmptyString(candidate.intermediateVersion)) return null
  if (!isNonEmptyString(candidate.targetVersion)) return null
  if (candidate.channel !== "stable" && candidate.channel !== "staging") return null
  if (!isNonEmptyString(candidate.minVersion)) return null
  if (!isNonEmptyString(candidate.createdAt)) return null
  return candidate as PendingUpdateChain
}

export function readPendingUpdateChain(): PendingUpdateChain | null {
  try {
    const statePath = getPendingUpdateChainPath()
    if (!existsSync(statePath)) return null
    const raw = readFileSync(statePath, "utf-8").replace(/^\uFEFF/, "")
    return parsePendingUpdateChain(JSON.parse(raw))
  } catch (err) {
    console.warn("[Updater] Failed to read pending update chain:", err)
    return null
  }
}

export function writePendingUpdateChain(state: Omit<PendingUpdateChain, "createdAt">): boolean {
  try {
    writeFileSync(
      getPendingUpdateChainPath(),
      JSON.stringify({ ...state, createdAt: new Date().toISOString() }, null, 2),
      "utf-8"
    )
    return true
  } catch (err) {
    console.warn("[Updater] Failed to persist pending update chain:", err)
    return false
  }
}

export function clearPendingUpdateChain(): void {
  try {
    const statePath = getPendingUpdateChainPath()
    if (!existsSync(statePath)) return
    unlinkSync(statePath)
  } catch (err) {
    console.warn("[Updater] Failed to clear pending update chain:", err)
  }
}

/**
 * Read a marker left by a pre-chain updater. The marker remains in resources
 * until the manifest proves its actual installed version satisfies minVersion.
 */
export function readLegacyUpdateMarker(): UpdateMarker | null {
  try {
    const markerPath = join(process.resourcesPath, "update-marker.json")
    if (!existsSync(markerPath)) return null
    const raw = readFileSync(markerPath, "utf-8").replace(/^\uFEFF/, "")
    const marker = JSON.parse(raw) as UpdateMarker
    return marker.releaseVersion === undefined ? marker : null
  } catch {
    return null
  }
}
