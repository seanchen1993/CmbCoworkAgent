import type { AgentAutoCommitResult } from "./auto-commit-types"

export function formatAutoCommitLines(result: AgentAutoCommitResult): string[] {
  const lines: string[] = []
  if (result.message) lines.push(result.message)
  if (result.commitMessage) lines.push(`提交信息：${result.commitMessage}`)
  if (result.commitHash) lines.push(`提交：${result.commitHash.slice(0, 12)}`)
  if (result.repoResults?.length) {
    for (const repo of result.repoResults) {
      const label = repo.displayPath || repo.repoPath
      const statusLabel =
        repo.status === "committed" ? "已提交" : repo.status === "failed" ? "失败" : "已跳过"
      const suffix = repo.commitHash ? ` ${repo.commitHash.slice(0, 12)}` : ""
      lines.push(`[${label}] ${statusLabel}${suffix}`)
      if (repo.reasons?.length) {
        for (const reason of repo.reasons) lines.push(`[${label}] ${reason}`)
      }
      if (repo.pushError) lines.push(`[${label}] 推送失败：${repo.pushError}`)
    }
  }
  if (result.committedFiles?.length) {
    lines.push(`纳入文件：${result.committedFiles.join("，")}`)
  }
  if (result.skippedFiles?.length) {
    lines.push(`未纳入文件：${result.skippedFiles.join("，")}`)
  }
  if (result.pushed === true) lines.push("已推送至远端")
  if (result.pushError) lines.push(`推送失败：${result.pushError}`)
  if (result.warnings?.length) lines.push(...result.warnings)
  if (result.reasons?.length) lines.push(...result.reasons)
  return lines
}

export function formatAutoCommitText(result: AgentAutoCommitResult): string {
  return formatAutoCommitLines(result).join("\n")
}
