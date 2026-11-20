export type ProjectAttentionSortKey =
  | "inclusiveAdoptionRate"
  | "vibecodingShare"
  | "suspectedTechnicalDetailConversationCount"

export const PROJECT_ATTENTION_SORTS: Array<{
  key: ProjectAttentionSortKey
  label: string
  metricLabel: string
  order: "asc" | "desc"
  hint: string
}> = [
  {
    key: "inclusiveAdoptionRate",
    label: "采纳率低优先",
    metricLabel: "总量提交采纳率",
    order: "asc",
    hint: "按总量口径的提交采纳率从低到高排列，包含尚未提交的生成代码。"
  },
  {
    key: "vibecodingShare",
    label: "VibeCoding 采纳占比高优先",
    metricLabel: "VibeCoding 采纳占比",
    order: "desc",
    hint: "VibeCoding 采纳行数 ÷ Harness 与 VibeCoding 采纳行数之和，与列表采纳行数占比一致；未归因代码不计入分母。"
  },
  {
    key: "suspectedTechnicalDetailConversationCount",
    label: "技术细节补充多优先",
    metricLabel: "疑似技术细节补充",
    order: "desc",
    hint: "按疑似技术细节补充的轮次数从多到少排列。"
  }
]

export function vibecodingAdoptedShare(harnessLines: number, vibeLines: number): number | null {
  const total = harnessLines + vibeLines
  return total > 0 ? vibeLines / total : null
}

export function isProjectAttentionSortKey(value: unknown): value is ProjectAttentionSortKey {
  return PROJECT_ATTENTION_SORTS.some((item) => item.key === value)
}

/** Missing observations are not zero adoption / high risk, in either direction. */
export function compareProjectAttentionValues(
  a: number | null,
  b: number | null,
  order: "asc" | "desc"
): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return order === "asc" ? a - b : b - a
}
