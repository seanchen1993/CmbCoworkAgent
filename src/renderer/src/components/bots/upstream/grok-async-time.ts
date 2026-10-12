/** Extracted from Grok 0.18 async-tasks/provider.ts; Chinese labels only. See PROVENANCE.json. */
export function formatAsyncTaskTime(timestampMs: number, nowMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || !Number.isFinite(nowMs)) return ""
  const elapsedMs = Math.max(0, nowMs - timestampMs)
  const seconds = Math.floor(elapsedMs / 1_000)
  if (seconds < 60) return "刚刚"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  return `${Math.floor(months / 12)} 年前`
}
