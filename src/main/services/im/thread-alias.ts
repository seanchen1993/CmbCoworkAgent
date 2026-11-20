import type { ThreadRow } from "../../db"
import { parseStandardThreadMetadata } from "../../agent/standard-thread-turn"

const MAX_FEATURE_LENGTH = 12
const MAX_STAGE_LENGTH = 10

function compact(value: string, limit: number): string {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim())
  return characters.length <= limit
    ? characters.join("")
    : `${characters.slice(0, limit - 1).join("")}…`
}

export function projectThreadAliasParts(thread: ThreadRow): {
  projectId: string
  featureSlug: string
  launchStageName: string | null
} | null {
  const feature = parseStandardThreadMetadata(thread.metadata).metadata.harnessFeature
  if (!feature || typeof feature !== "object" || Array.isArray(feature)) return null
  const record = feature as Record<string, unknown>
  const projectId = typeof record.projectId === "string" ? record.projectId.trim() : ""
  const featureSlug = typeof record.slug === "string" ? record.slug.trim() : ""
  if (!projectId || !featureSlug) return null
  return {
    projectId,
    featureSlug,
    launchStageName:
      typeof record.launchStageName === "string" ? record.launchStageName.trim() || null : null
  }
}

export function projectThreadAlias(featureTitle: string, launchStageName: string | null): string {
  const feature = compact(featureTitle, MAX_FEATURE_LENGTH)
  return launchStageName ? `${feature} · ${compact(launchStageName, MAX_STAGE_LENGTH)}` : feature
}

export function imActivityTime(timestamp: number, includeSeconds = false): string {
  const date = new Date(timestamp + 8 * 60 * 60_000)
  const two = (value: number): string => String(value).padStart(2, "0")
  const time = `${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`
  return includeSeconds ? `${time}:${two(date.getUTCSeconds())}` : time
}
