export const HOOK_TIME_ZONE = "Asia/Shanghai"
export const HOOK_TIME_ZONE_LABEL = "北京时间（UTC+8）"

export type HookTimeInput = Date | string | number

const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const ISO_LOCAL_DATE_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/
const ISO_ZONED_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i

const hookDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HOOK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
})

const hookDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HOOK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
})

/** Parse Hook timestamps without ever falling back to the host's local timezone. */
export function parseHookTimestamp(value: HookTimeInput): Date | null {
  let date: Date
  if (value instanceof Date) {
    date = new Date(value.getTime())
  } else if (typeof value === "number") {
    date = new Date(value)
  } else {
    const timestamp = value.trim()
    const localDateTime = ISO_LOCAL_DATE_TIME_PATTERN.exec(timestamp)
    if (ISO_DATE_ONLY_PATTERN.test(timestamp)) {
      date = new Date(`${timestamp}T00:00:00+08:00`)
    } else if (localDateTime) {
      date = new Date(`${localDateTime[1]}T${localDateTime[2]}+08:00`)
    } else if (ISO_ZONED_DATE_TIME_PATTERN.test(timestamp)) {
      date = new Date(timestamp)
    } else {
      return null
    }
  }
  return Number.isFinite(date.getTime()) ? date : null
}

function partsByType(
  formatter: Intl.DateTimeFormat,
  date: Date
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const result: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {}
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") result[part.type] = part.value
  }
  return result
}

/** Return the fixed Beijing calendar date for an instant as YYYY-MM-DD. */
export function getHookDateKey(value: HookTimeInput = new Date()): string {
  const date = parseHookTimestamp(value)
  if (!date) throw new RangeError("Invalid Hook timestamp")
  const parts = partsByType(hookDateFormatter, date)
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** Format an instant for Hook UI without depending on the operating-system timezone. */
export function formatHookDateTime(value: HookTimeInput): string | null {
  const date = parseHookTimestamp(value)
  if (!date) return null
  const parts = partsByType(hookDateTimeFormatter, date)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** Compact fixed-Beijing clock time used by Hook execution rows. */
export function formatHookClockTime(value: HookTimeInput): string | null {
  const formatted = formatHookDateTime(value)
  return formatted?.slice(11) ?? null
}
