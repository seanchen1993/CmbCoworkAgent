import type { WorkspaceFileScanEntry } from "../../../shared/workspace-file-scan"

const relativeTime = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })

/** Group one bounded scan page; do not read files or manufacture delivery timestamps. */
export function botLibraryGroups(files: WorkspaceFileScanEntry[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const week = new Date(today)
  week.setDate(week.getDate() - ((week.getDay() + 6) % 7))
  const month = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const buckets = ["今天", "本周", "本月", "更早", "日期未知"].map((label) => ({
    label,
    files: [] as { file: WorkspaceFileScanEntry; modified: number; timeLabel: string }[]
  }))
  for (const file of files) {
    if (file.is_dir) continue
    const modified = Date.parse(file.modified_at ?? "")
    const known = Number.isFinite(modified)
    const bucket = !known
      ? 4
      : modified >= today
        ? 0
        : modified >= week.getTime()
          ? 1
          : modified >= month
            ? 2
            : 3
    const seconds = Math.round((modified - now.getTime()) / 1000)
    const timeLabel = !known
      ? ""
      : Math.abs(seconds) < 60
        ? "刚刚"
        : Math.abs(seconds) < 3600
          ? relativeTime.format(Math.trunc(seconds / 60), "minute")
          : Math.abs(seconds) < 86400
            ? relativeTime.format(Math.trunc(seconds / 3600), "hour")
            : new Date(modified).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
    buckets[bucket].files.push({ file, modified, timeLabel })
  }
  for (const bucket of buckets) {
    bucket.files.sort(
      (a, b) =>
        (Number.isFinite(b.modified) ? b.modified : 0) -
          (Number.isFinite(a.modified) ? a.modified : 0) || a.file.path.localeCompare(b.file.path)
    )
  }
  return buckets.filter((bucket) => bucket.files.length > 0)
}
