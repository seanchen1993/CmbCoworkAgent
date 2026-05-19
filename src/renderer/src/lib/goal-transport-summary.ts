const GOAL_TRANSPORT_SUMMARY_PREFIX = "启动上下文摘要："

export function stripGoalTransportSummary(content: string): {
  text: string
  skillName: string | null
} {
  if (!content.includes(GOAL_TRANSPORT_SUMMARY_PREFIX)) return { text: content, skillName: null }

  let skillName: string | null = null
  const lines = content.split(/\r?\n/)
  const keptLines = lines.flatMap((line) => {
    const summaryIndex = line.indexOf(GOAL_TRANSPORT_SUMMARY_PREFIX)
    if (summaryIndex < 0) return [line]

    const summary = line.slice(summaryIndex + GOAL_TRANSPORT_SUMMARY_PREFIX.length)
    const skillMatch = summary.match(/(?:^|[；;])\s*显式技能：([^；;\n]+)/)
    if (skillMatch?.[1]) {
      skillName = skillMatch[1].trim()
    }

    const beforeSummary = line.slice(0, summaryIndex).trimEnd()
    return beforeSummary ? [beforeSummary] : []
  })

  return {
    text: keptLines.join("\n").trimEnd(),
    skillName
  }
}

export function stripLegacyGoalTransportSummary(content: string): {
  text: string
  skillName: string | null
} {
  if (!content.trimStart().startsWith("/goal")) return { text: content, skillName: null }
  return stripGoalTransportSummary(content)
}
