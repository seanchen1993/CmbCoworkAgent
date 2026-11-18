/** The desktop chooser supplies identity only. The target resolves actual skill metadata. */
export interface BotSkillSelection {
  name: string
  path: string
}

/** A saved skill schedule has no running task receipt until the first deadline. */
export function isSavedBotSkillSchedule(value: unknown, expectedWorkId?: unknown): value is {
  id: string; name: string; enabled: true; workId: string; skillName: string; timezone: string; nextRunAt: string
} {
  if (!value || typeof value !== "object") return false
  const s = value as Record<string, unknown>
  const hasText = (v: unknown) => typeof v === "string" && !!v.trim()
  return s.enabled === true && hasText(s.id) && hasText(s.name) && hasText(s.workId) &&
    hasText(s.skillName) && hasText(s.timezone) && typeof s.nextRunAt === "string" &&
    Number.isFinite(Date.parse(s.nextRunAt)) && (expectedWorkId === undefined || s.workId === expectedWorkId)
}
