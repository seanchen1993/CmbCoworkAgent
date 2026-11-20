import type { Granularity } from "./use-dashboard"

// 普通用户可查询一个季度；取自然季度可能出现的最大跨度（含首尾日期）。
export const DEFAULT_CUSTOM_RANGE_MAX_DAYS = 92
export const ADMIN_CUSTOM_RANGE_MAX_DAYS = 366
export const MS_PER_DAY = 24 * 60 * 60 * 1000

export function formatRangeLabel(from: string, to: string, granularity: Granularity): string {
  const f = new Date(from)
  const pad = (n: number): string => String(n).padStart(2, "0")
  const fmtDate = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  if (granularity === "day") return fmtDate(f)
  if (granularity === "custom") return `${fmtDate(f)} ~ ${fmtDate(new Date(to))}`
  if (granularity === "week") {
    const t = new Date(to)
    return `${fmtDate(f)} ~ ${fmtDate(t)}`
  }
  // month
  return `${f.getFullYear()}-${pad(f.getMonth() + 1)}`
}

export function formatDateInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addDaysToDateInput(value: string, days: number): string {
  const date = new Date(value + "T00:00:00")
  date.setDate(date.getDate() + days)
  return formatDateInputValue(date)
}
