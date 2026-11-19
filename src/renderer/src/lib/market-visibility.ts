import type { MarketItem } from "../api/market"
import { buildUploaderIdCandidates, getUploaderIdCandidates } from "./skill-data-service"

export interface MarketViewerIdentity {
  sapId?: string
  ystId?: string
  pathName?: string
}

export function getMarketViewerIdCandidates(user: MarketViewerIdentity | null): string[] {
  const ids = [user?.sapId, user?.ystId].map((id) => id?.trim() || "").filter(Boolean)
  return Array.from(new Set(ids.flatMap((id) => buildUploaderIdCandidates(id))))
}

type MarketExtraJson = {
  skills?: string[]
  grayUserIds?: string[]
  grayOrgs?: string[]
  updated_at?: string
}

export function parseMarketExtraJson(extraJson?: string): MarketExtraJson {
  if (!extraJson?.trim()) return {}
  try {
    const parsed = JSON.parse(extraJson) as MarketExtraJson
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function getGrayUserIdsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  if (!Array.isArray(parsed.grayUserIds)) return []
  return Array.from(
    new Set(
      parsed.grayUserIds
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function getGrayOrgsFromExtraJson(extraJson?: string): string[] {
  const parsed = parseMarketExtraJson(extraJson)
  if (!Array.isArray(parsed.grayOrgs)) return []
  return Array.from(
    new Set(
      parsed.grayOrgs
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

export function doesMarketUserIdMatchCurrentUser(
  rawUserId: string | null | undefined,
  currentUserIdCandidates: Iterable<string>,
  currentUserSapId?: string | null | undefined
): boolean {
  const normalizedCurrentIds = Array.from(
    new Set([
      ...Array.from(currentUserIdCandidates, (value) => String(value || "").trim()).filter(Boolean),
      ...buildUploaderIdCandidates(currentUserSapId || undefined)
    ])
  )
  if (!rawUserId || normalizedCurrentIds.length === 0) return false

  const targetCandidates = getUploaderIdCandidates(rawUserId)
  return targetCandidates.some((candidate) =>
    normalizedCurrentIds.some(
      (currentId) =>
        currentId === candidate || currentId.includes(candidate) || candidate.includes(currentId)
    )
  )
}

export function canCurrentUserViewMarketItem(
  item: Pick<MarketItem, "user_id" | "extra_json">,
  currentUserSapId: string | null | undefined,
  currentUserIdCandidates: Iterable<string>,
  currentUserPathName?: string | null | undefined
): boolean {
  if (doesMarketUserIdMatchCurrentUser(item.user_id, currentUserIdCandidates, currentUserSapId)) {
    return true
  }
  const grayUserIds = getGrayUserIdsFromExtraJson(item.extra_json)
  const grayOrgs = getGrayOrgsFromExtraJson(item.extra_json)

  if (grayUserIds.length === 0 && grayOrgs.length === 0) return true

  if (
    grayUserIds.some((userId) =>
      doesMarketUserIdMatchCurrentUser(userId, currentUserIdCandidates, currentUserSapId)
    )
  ) {
    return true
  }

  if (currentUserPathName && grayOrgs.some((org) => currentUserPathName.includes(org))) {
    return true
  }

  return false
}
