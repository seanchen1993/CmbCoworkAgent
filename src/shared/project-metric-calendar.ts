const DAY_MS = 86_400_000
const GMT8_MS = 8 * 60 * 60 * 1000

// 国务院放假、调休安排；运行时不联网。来源见 docs/项目度量看板设计.md 第 7 节。
const CALENDARS: Record<number, { holidays: string[]; workingWeekends: string[] }> = {
  2026: {
    holidays: [
      "01-01/01-03",
      "02-15/02-23",
      "04-04/04-06",
      "05-01/05-05",
      "06-19/06-21",
      "09-25/09-27",
      "10-01/10-07"
    ],
    workingWeekends: ["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"]
  },
  2027: {
    holidays: [
      "01-01/01-03",
      "02-05/02-13",
      "04-03/04-05",
      "05-01/05-05",
      "06-09/06-09",
      "09-15/09-15",
      "10-01/10-07"
    ],
    workingWeekends: ["01-31", "02-14", "05-08", "09-26", "10-09"]
  }
}

/** 企业无时区日期固定按 GMT+8 解读，不依赖运行设备时区。 */
export function projectDateMillis(value: string | null | undefined): number | null {
  if (!value) return null
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value
  )
  if (local) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0", fraction = "0"] = local
    const date = new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss, +fraction.padEnd(3, "0")))
    if (
      date.getUTCFullYear() !== +y ||
      date.getUTCMonth() !== +m - 1 ||
      date.getUTCDate() !== +d ||
      +hh > 23 ||
      +mm > 59 ||
      +ss > 59
    )
      return null
    return date.getTime() - GMT8_MS
  }
  // 看板传输时间含明确时区；不接受无时区的其他格式。
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function formatProjectDate(value: number | Date): string {
  return new Date(Number(value) + GMT8_MS).toISOString().slice(0, 19).replace("T", " ")
}

export function projectRangeBounds(range: { from: string; to: string }): {
  gte: string
  lt: string
} {
  const from = projectDateMillis(range.from)
  const to = projectDateMillis(range.to)
  if (from === null || to === null || to < from) throw new Error("项目度量日期范围无效")
  return {
    gte: formatProjectDate(from).slice(0, 10) + " 00:00:00",
    lt: formatProjectDate(Math.floor((to + GMT8_MS) / DAY_MS) * DAY_MS - GMT8_MS + DAY_MS)
  }
}

export function projectNaturalMonth(range: { from: string; to: string }): string | null {
  const bounds = projectRangeBounds(range)
  const month = bounds.gte.slice(0, 7)
  const next =
    new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10) +
    " 00:00:00"
  return bounds.gte === `${month}-01 00:00:00` && bounds.lt === next ? month : null
}

// 两年日历只有 730 天。预先累计工作日，统计、排序和导出无需对每个项目逐日遍历。
const CALENDAR_START = Date.UTC(2026, 0, 1) - GMT8_MS
const CALENDAR_END = Date.UTC(2028, 0, 1) - GMT8_MS
const WORKING_DAY_PREFIX = [0]
const WORKING_DAYS: boolean[] = []
for (let time = CALENDAR_START; time < CALENDAR_END; time += DAY_MS) {
  const date = new Date(time + GMT8_MS)
  const calendar = CALENDARS[date.getUTCFullYear()]
  const monthDay = date.toISOString().slice(5, 10)
  const holiday = calendar.holidays.some((interval) => {
    const [first, last] = interval.split("/")
    return monthDay >= first && monthDay <= last
  })
  const working =
    calendar.workingWeekends.includes(monthDay) ||
    (!holiday && date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
  WORKING_DAYS.push(working)
  WORKING_DAY_PREFIX.push(WORKING_DAY_PREFIX[WORKING_DAY_PREFIX.length - 1] + Number(working))
}

export function projectWorkingDays(start: string | null, end: string | null): number | null {
  const a = projectDateMillis(start)
  const b = projectDateMillis(end)
  if (
    a === null ||
    b === null ||
    b < a ||
    a < CALENDAR_START ||
    a >= CALENDAR_END ||
    b > CALENDAR_END
  )
    return null
  const elapsed = (time: number): number => {
    const index = Math.floor((time - CALENDAR_START) / DAY_MS)
    const partialDay = (time - CALENDAR_START) % DAY_MS
    return WORKING_DAY_PREFIX[index] * DAY_MS + (WORKING_DAYS[index] ? partialDay : 0)
  }
  return (elapsed(b) - elapsed(a)) / DAY_MS
}

export const PROJECT_CALENDAR_NOTE =
  "耗时按 GMT+8 国家工作日计算，含调休，保留小数；日历覆盖 2026、2027 年，缺失、倒置或超出日历范围的日期不参与均值。"
