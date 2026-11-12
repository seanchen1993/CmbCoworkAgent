export type MarketSourceAccess = "owner" | "whitelist"

export interface MarketSourceIdentity {
  name: string
  id?: string
}

export function canReadPluginSource(
  plugin: { origin?: string; sourceAccess?: MarketSourceAccess } | null | undefined
): boolean {
  return Boolean(
    plugin &&
    (plugin.origin === "local" ||
      (plugin.origin === "market" &&
        (plugin.sourceAccess === "owner" || plugin.sourceAccess === "whitelist")))
  )
}

export function parseSourceAccessUserIds(extraJson?: string): string[] {
  try {
    const values: unknown = JSON.parse(extraJson || "{}").sourceAccessUserIds
    return Array.isArray(values)
      ? [
          ...new Set(
            values
              .filter((id): id is string => typeof id === "string")
              .map((id) => id.trim())
              .filter(Boolean)
          )
        ]
      : []
  } catch {
    return []
  }
}

/** Match account IDs exactly; names, office IPs and visibility rules confer no source rights. */
export function getMarketSourceAccess(
  item: { user_id?: string; extra_json?: string },
  user: { sapId?: string; ystId?: string } | null
): MarketSourceAccess | undefined {
  const ids = [user?.sapId, user?.ystId].map((id) => id?.trim()).filter(Boolean)
  if (!ids.length) return undefined
  // Published user_id has the form "account ID / display name / organization".
  const owner = typeof item.user_id === "string" ? item.user_id.split("/")[0].trim() : ""
  if (owner && ids.includes(owner)) return "owner"
  return parseSourceAccessUserIds(item.extra_json).some((id) => ids.includes(id))
    ? "whitelist"
    : undefined
}
