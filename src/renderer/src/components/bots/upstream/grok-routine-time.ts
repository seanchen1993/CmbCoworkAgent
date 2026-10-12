/** Grok 0.18 routine history calendar-relative time; localized to Chinese and a 24-hour clock. See PROVENANCE.json. */
interface ZonedParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly weekday: number
  readonly hour: number
  readonly minute: number
}

const MONTHS = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月"
] as const
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
] as const

function zonedParts(timestamp: number, timeZone?: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...(timeZone == null ? {} : { timeZone }),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  )
  const weekday = WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number])
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekday < 0 ? new Date(timestamp).getDay() : weekday,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute)
  }
}

function dateKey(timestamp: number, timeZone?: string): number {
  const parts = zonedParts(timestamp, timeZone)
  return Date.UTC(parts.year, parts.month - 1, parts.day)
}

function clock(parts: ZonedParts): string {
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`
}

/** Mirrors the immutable pgn + M2n relative timestamp branch. */
export function formatRoutineRunTimestamp(
  startedAt: number,
  now: number,
  timeZone?: string
): string {
  const difference = startedAt - now
  let result: string
  if (difference > 0 && difference < 60 * 60 * 1000)
    result = `${Math.ceil(difference / (60 * 1000))} 分钟后`
  else if (difference <= 0 && -difference < 60 * 1000) result = "刚刚"
  else if (difference <= 0 && -difference < 60 * 60 * 1000)
    result = `${Math.floor(-difference / (60 * 1000))} 分钟前`
  else {
    const current = zonedParts(now, timeZone)
    const started = zonedParts(startedAt, timeZone)
    const dayDifference = Math.round(
      (dateKey(startedAt, timeZone) - dateKey(now, timeZone)) / (24 * 60 * 60 * 1000)
    )
    if (dayDifference === 0) result = `今天 ${clock(started)}`
    else if (dayDifference === 1) result = `明天 ${clock(started)}`
    else if (dayDifference === -1) result = `昨天 ${clock(started)}`
    else if (dayDifference > 1 && dayDifference < 7)
      result = `周${"日一二三四五六"[started.weekday]} ${clock(started)}`
    else if (dayDifference < -1 && dayDifference > -7)
      result = `上个周${"日一二三四五六"[started.weekday]} ${clock(started)}`
    else {
      const date = `${MONTHS[started.month - 1]}${started.day}日`
      result =
        started.year === current.year
          ? `${date} ${clock(started)}`
          : `${started.year}年${date} ${clock(started)}`
    }
  }
  return result.charAt(0).toUpperCase() + result.slice(1)
}
