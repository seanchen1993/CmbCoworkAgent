/**
 * Local time formatting — single source of truth for the main process.
 *
 * Returns the current time as an ISO 8601 string anchored to the local
 * timezone instead of UTC, e.g.
 *
 *   "2026-04-08T10:30:15.123+08:00"
 *
 * Why not `new Date().toISOString()`?
 *   `toISOString()` always renders in UTC ("...Z"), so a Beijing user sees
 *   the wrong wall-clock when grepping raw trace / event JSON files.
 *
 * Why ISO 8601 with offset (and not a free-form "YYYY-MM-DD HH:mm:ss")?
 *   - JavaScript `new Date(<this string>)` parses it natively, so duration
 *     math (`Date.now() - new Date(start).getTime()`) keeps working.
 *   - Elasticsearch's default `strict_date_optional_time` mapping accepts
 *     it without any custom `format` declaration.
 *   - It is still readable enough for humans skimming logs.
 *
 * The output is deliberately stable and free of locale dependencies.
 */

export function nowIsoLocal(date: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0")

  const year  = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day   = pad(date.getDate())
  const hour  = pad(date.getHours())
  const min   = pad(date.getMinutes())
  const sec   = pad(date.getSeconds())
  const ms    = pad(date.getMilliseconds(), 3)

  // getTimezoneOffset() returns minutes WEST of UTC; invert to express
  // the conventional "east-positive" offset (+08:00 for Beijing).
  const offsetMin   = -date.getTimezoneOffset()
  const offsetSign  = offsetMin >= 0 ? "+" : "-"
  const offsetHours = pad(Math.floor(Math.abs(offsetMin) / 60))
  const offsetMins  = pad(Math.abs(offsetMin) % 60)

  return `${year}-${month}-${day}T${hour}:${min}:${sec}.${ms}${offsetSign}${offsetHours}:${offsetMins}`
}
