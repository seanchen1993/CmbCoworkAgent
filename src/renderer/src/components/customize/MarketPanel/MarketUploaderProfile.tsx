import type React from "react"
import type { MarketItem } from "../../../api/market"

export interface UploaderProfile {
  sapId: string
  userName: string
  orgName: string
  upperOrgLv0?: string
  upperOrgLv1?: string
}

export function getOrgSkillUploaderProfile(item: MarketItem): UploaderProfile | null {
  const rawUserId = item.user_id?.trim()
  const managerName = item.managerName?.trim()
  const managerDepartment = item.managerDepartment?.trim()
  if (!rawUserId && !managerName && !managerDepartment) return null

  return {
    sapId: rawUserId || "—",
    userName: managerName || "未知用户",
    orgName: managerDepartment || "—"
  }
}

export function renderUploaderProfile(
  profile: UploaderProfile | null,
  fallbackUserId?: string,
  options: { multiline?: boolean } = {}
): React.ReactNode {
  const { multiline = false } = options
  if (!profile) {
    return (
      <span
        className={multiline ? "min-w-0 whitespace-normal break-all leading-relaxed" : "truncate"}
      >
        {fallbackUserId || "—"}
      </span>
    )
  }
  const target = profile
  const userName = target.userName || "未知用户"
  const sapId = target.sapId || "—"
  const orgName = target.orgName || "—"

  if (multiline) {
    return (
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1 gap-y-0.5 whitespace-normal leading-relaxed">
        <span className="min-w-0 break-words">{userName}</span>
        <span className="break-all text-muted-foreground">（{sapId}）</span>
        <span className="min-w-0 break-words text-muted-foreground">{orgName}</span>
      </span>
    )
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate">{userName}</span>
      <span className="shrink-0 text-muted-foreground">（{sapId}）</span>
      <span className="shrink-0 text-muted-foreground">{orgName}</span>
    </span>
  )
}
