/** Shared desktop/Bot time context. A remote Host must receive the desktop's
 * timezone explicitly instead of treating its server timezone as the user's. */
export function runtimeTimezone(configured?: unknown): string {
  const timezone =
    configured === undefined
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : configured
  if (typeof timezone !== "string" || !timezone || timezone.length > 100)
    throw new Error("运行时区配置无效，请检查时区名称")
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone })
  } catch {
    throw new Error("运行时区配置无效，请检查时区名称")
  }
  return timezone
}

/** Local ISO-8601 using calendar parts; parsing locale strings in the process
 * timezone can shift the offset by an hour across that zone's DST transition. */
export function formatLocalISO(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date)
  const get = (type: string): string => parts.find((part) => part.type === type)!.value
  const wall = new Date(0)
  wall.setUTCFullYear(Number(get("year")), Number(get("month")) - 1, Number(get("day")))
  wall.setUTCHours(Number(get("hour")), Number(get("minute")), Number(get("second")), 0)
  const offsetMin = Math.round((wall.getTime() - Math.floor(date.getTime() / 1000) * 1000) / 60_000)
  const sign = offsetMin >= 0 ? "+" : "-"
  const absMin = Math.abs(offsetMin)
  const oh = String(Math.floor(absMin / 60)).padStart(2, "0")
  const om = String(absMin % 60).padStart(2, "0")
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${sign}${oh}:${om}`
}

export function getRuntimeTimeContext(
  date: Date = new Date(),
  configured?: unknown
): {
  timezone: string
  currentTime: string
} {
  const timezone = runtimeTimezone(configured)
  return { timezone, currentTime: formatLocalISO(date, timezone) }
}

export function renderRuntimeTimeContextLines(
  timeContext: ReturnType<typeof getRuntimeTimeContext>,
  options: { includeCurrentTime?: boolean; includeTimestampRule?: boolean } = {}
): string {
  const includeCurrentTime = options.includeCurrentTime ?? true
  const includeTimestampRule = includeCurrentTime && options.includeTimestampRule === true
  return [
    `- Timezone: ${timeContext.timezone}`,
    ...(includeCurrentTime ? [`- Current time: ${timeContext.currentTime}`] : []),
    ...(includeTimestampRule
      ? [
          "- Timestamp rule: Do not invent dates or timestamps. If a timestamp is useful, use the current time above; otherwise omit it."
        ]
      : [])
  ].join("\n")
}
