import type { ModAuditEntry } from "../../../shared/mods/types"
import type { BuiltinRunOverview } from "../../../shared/mods/builtins"
import type { BuiltinInstructionsReadResult } from "../../../shared/mods/builtin-instructions"

/** A bounded view of existing facts. Does not validate artifacts or start guest/model work. */
export function projectBuiltinRunOverview(input: {
  threadId: string
  workspace: string
  capturedAt: number
  instructions: BuiltinInstructionsReadResult
  records: readonly ModAuditEntry[]
  limited: boolean
  policy: { required: boolean; denyTools: readonly string[] }
}): BuiltinRunOverview {
  const records = [
    ...new Map(
      input.records
        .filter(
          (row) =>
            row.identity?.threadId === input.threadId && row.identity.workspace === input.workspace
        )
        .map((row) => [row.callId, row])
    ).values()
  ]
  const counts = (status: ModAuditEntry["status"]) =>
    records.filter((row) => row.status === status).length
  const durations = records.flatMap((row) =>
    row.finishedAt !== null &&
    Number.isFinite(row.startedAt) &&
    Number.isFinite(row.finishedAt) &&
    row.finishedAt >= row.startedAt
      ? [{ start: row.startedAt, end: row.finishedAt }]
      : []
  )
  const tokenSum = (key: "inputTokens" | "outputTokens") => {
    const values = records.flatMap((row) => {
      const value = row.modelUsage?.[key]
      return Number.isSafeInteger(value) && value! >= 0 ? [value!] : []
    })
    const total = values.reduce((sum, value) => sum + value, 0)
    return values.length && Number.isSafeInteger(total) ? total : null
  }
  const recordedBlocks = records.filter((row) => row.publication === "blocked").length
  const failed = counts("failed"),
    unknown = counts("unknown")
  const suggestions: BuiltinRunOverview["suggestions"] = []
  if (unknown)
    suggestions.push({
      id: "check-unknown",
      title: "先核对未确认的操作结果",
      detail: "已有记录无法确认部分操作是否完成。先查看实际产物和原记录，再决定是否重试。"
    })
  if (failed)
    suggestions.push({
      id: "inspect-failed",
      title: "查看失败记录后再修复",
      detail: "运行过程中保留了失败记录。修复后需要新一轮检查，旧失败不会变成通过。"
    })
  if (recordedBlocks)
    suggestions.push({
      id: "inspect-policy",
      title: "查看被阻止的输出",
      detail: "部分输出未通过宿主发布检查。请查看原调用记录；这里不会放行或重新执行。"
    })
  return {
    threadId: input.threadId,
    workspace: input.workspace,
    capturedAt: input.capturedAt,
    instructions: input.instructions,
    policy: {
      required: input.policy.required,
      blockedTools: [...input.policy.denyTools],
      recordedBlocks,
      explanation:
        "列出宿主灵件策略的工具限制及本聊天已有输出拦截；其他审批与项目阶段规则仍由原入口执行。"
    },
    metrics: {
      scope: "retained-plugin-calls",
      sampled: records.length,
      succeeded: counts("succeeded"),
      failed,
      running: counts("running"),
      unknown,
      durationMs: durations.length
        ? Math.max(...durations.map((row) => row.end)) -
          Math.min(...durations.map((row) => row.start))
        : null,
      inputTokens: tokenSum("inputTokens"),
      outputTokens: tokenSum("outputTokens"),
      cost: null,
      limited: input.limited,
      explanation:
        "仅统计当前聊天保留的灵件调用；时间为已结束记录覆盖的时间跨度，含间隔，不是任务总耗时。用量仅合计有回执的部分，费用未知。"
    },
    suggestions
  }
}
