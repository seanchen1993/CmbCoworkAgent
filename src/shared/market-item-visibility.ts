export interface UploaderProfileInfo {
  sapId: string
  userName: string
  orgName: string
}

export interface ParsedUploaderIdentity extends UploaderProfileInfo {
  raw: string
  segments: string[]
}

export function normalizeUploaderProfileField(value?: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) return ""
  if (
    normalized === "未知用户" ||
    normalized === "未知部门" ||
    normalized.toLowerCase() === "unknown"
  ) {
    return ""
  }
  return normalized
}

export function normalizeUploaderMapKey(rawUserId?: string): string {
  return String(rawUserId || "").trim()
}

export function parseUploaderIdentity(rawUserId?: string): ParsedUploaderIdentity | null {
  const raw = String(rawUserId || "").trim()
  if (!raw) return null
  const segments = raw
    .replace(/／/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
  if (segments.length === 0) return null

  return {
    raw,
    segments,
    sapId: segments[0] || "",
    userName: normalizeUploaderProfileField(segments[1]),
    orgName: normalizeUploaderProfileField(segments.slice(2).join(" / "))
  }
}

export function buildUploaderIdCandidates(rawUserIdOrSapId?: string): string[] {
  const parsed = parseUploaderIdentity(rawUserIdOrSapId)
  const baseId = normalizeUploaderMapKey(parsed?.sapId || rawUserIdOrSapId)
  if (!baseId) return []

  const candidates = new Set<string>([baseId])
  if (/^\d{6}$/.test(baseId)) {
    candidates.add(`80${baseId}`)
  }
  if (/^80\d{6}$/.test(baseId)) {
    candidates.add(baseId.slice(2))
  }
  return Array.from(candidates)
}

export function getUploaderIdCandidates(rawUserId?: string): string[] {
  const parsed = parseUploaderIdentity(rawUserId)
  return [
    rawUserId?.trim(),
    parsed?.sapId,
    ...buildUploaderIdCandidates(parsed?.sapId || rawUserId)
  ].filter((value): value is string => Boolean(value))
}

function readVisibilityFields(extraJson?: string): {
  grayUserIds?: unknown
  grayOrgs?: unknown
} {
  try {
    return JSON.parse(extraJson || "{}") ?? {}
  } catch {
    return {}
  }
}

function getGrayUserIdsFromExtraJson(extraJson?: string): string[] {
  const parsed = readVisibilityFields(extraJson)
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
  const parsed = readVisibilityFields(extraJson)
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
  item: { user_id?: string; extra_json?: string },
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
    grayUserIds.length > 0 &&
    grayUserIds.some((userId) =>
      doesMarketUserIdMatchCurrentUser(userId, currentUserIdCandidates, currentUserSapId)
    )
  ) {
    return true
  }

  if (
    grayOrgs.length > 0 &&
    currentUserPathName &&
    grayOrgs.some((org) => currentUserPathName.includes(org))
  ) {
    return true
  }

  return false
}
