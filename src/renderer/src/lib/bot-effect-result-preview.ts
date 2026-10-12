/** Collapsed recovery rows show an outcome, not internal browser tickets.
 * Full, paged receipts stay available through the existing effect details. */
export function botEffectResultPreview(result: string | null | undefined): string {
  if (!result) return "进程中断，未收到执行结果"
  const prefix = result.slice(0, 8000).trimStart()
  if (!prefix.trim()) return "进程中断，未收到执行结果"
  if (!/^[{[]/.test(prefix)) return result.slice(0, 2000)
  if (result.length <= 8000) {
    try {
      const value: unknown = JSON.parse(prefix)
      if (
        value &&
        typeof value === "object" &&
        "summary" in value &&
        typeof value.summary === "string" &&
        value.summary.trim()
      )
        return value.summary.slice(0, 2000)
    } catch {
      // A truncated receipt is still retained; its raw prefix is not a summary.
    }
  }
  return "执行记录已保存，展开查看操作与结果"
}
