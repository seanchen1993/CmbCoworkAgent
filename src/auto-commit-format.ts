import type { AgentAutoCommitResult } from "./main/types"

export function formatAutoCommitLines(result: AgentAutoCommitResult): string[] {
  const lines: string[] = []
  if (result.message) lines.push(result.message)
  if (result.commitMessage) lines.push(`提交信息：${result.commitMessage}`)
  if (result.commitHash) lines.push(`提交：${result.commitHash.slice(0, 12)}`)
  if (result.committedFiles?.length) {
    lines.push(`纳入文件：${result.committedFiles.join("，")}`)
  }
  if (result.skippedFiles?.length) {
    lines.push(`未纳入文件：${result.skippedFiles.join("，")}`)
  }
  if (result.warnings?.length) lines.push(...result.warnings)
  if (result.reasons?.length) lines.push(...result.reasons)
  return lines
}

export function formatAutoCommitText(result: AgentAutoCommitResult): string {
  return formatAutoCommitLines(result).join("\n")
}
