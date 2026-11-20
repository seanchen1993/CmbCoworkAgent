/** Tokens can refresh without changing which account/organization owns the UI. */
export function userIdentityKey(
  user: {
    sapId?: string
    ystId?: string
    originOrgId?: string
    originPathId?: string
    pathName?: string
  } | null
): string {
  return JSON.stringify([
    user?.sapId ?? "",
    user?.ystId ?? "",
    user?.originOrgId ?? "",
    user?.originPathId ?? "",
    user?.pathName ?? ""
  ])
}
