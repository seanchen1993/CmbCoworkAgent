/** Host control receipts are not execution failures. Unknown or errored results stay errors. */
export const BOT_CONTINUATION_KIND = "bot-foreground-continuation"

export const BOT_TOOL_OPENING = "我来看看。"

const controlInstructions = {
  result_review_scope: "This call did not execute. Answer from the returned findings if sufficient. For a material gap, inspect this task's retained evidence with bot_work_result_read.",
  result_report_scope: "This call did not execute. Answer from the supplied outcome and receipts. Identify any unresolved fact that affects the conclusion.",
  result_tool_outside_review: "只有原主 Bot 的当前结果回合可以处理此结果。",
  skill_dispatch_scope: "The selected-skill dispatch did not execute this call. Only one bot_skill_dispatch call is allowed in this main turn. Explain the actual blocker; do not perform the work here or claim acceptance without its receipt."
} as const

export function botToolControlReceipt(reason: keyof typeof controlInstructions, call: { id?: string; name: string }): string {
  return JSON.stringify({ kind: "bot-tool-control", version: 1, reason, executed: false,
    callId: call.id, tool: call.name, instruction: controlInstructions[reason] })
}

// Exact host receipts from earlier releases, including the original review gate.
const historicalControlErrors = new Set<string>([
  ...Object.values(controlInstructions),
  JSON.stringify({ ok: false, error: controlInstructions.result_tool_outside_review }),
  "Foreground execution budget reached. This tool has NOT run. Keep the main chat available: hand the remaining assignment to bot_work_create, or continue its existing task/Feature. Include the user's goal and constraints, selected workspace, completed findings and exact command receipts; do not repeat completed actions or restart an accepted background command. Then briefly tell the user where the work continues. Do not poll or work around this boundary with another tool.",
  "Foreground execution budget reached. This tool has NOT run. Keep the main chat available: hand the remaining assignment to bot_work_create, or continue its existing task/Feature. Include the user's goal and constraints, selected workspace, completed findings and exact command receipts; do not repeat completed actions or restart an accepted background command. Use finishTurn: true on the final dispatch batch. Keep the same assistant voice; do not mention budgets, internal errors or handing the user to another agent. If already acknowledged, do not add another acknowledgement. Do not poll or work around this boundary with another tool.",
  "Only the four scoped bot_work_result tools can run in a result review. This call did not execute.",
  "This task_result event cannot invoke tools. The call did not execute. Report only the supplied result, host status and receipts; do not retry or start work."
])

export type BotToolReceipt =
  | { kind: "control" }
  | { kind: "attempt" | "recovery"; operation: string; attempt: number }

// These native message IDs survive both streaming and history. No provider/tool payload is inspected.
const nativeId = /^bot-(control|attempt|recovery)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:-([1-9]\d{0,14}))?$/

export function parseBotToolReceiptId(id: string, toolName: string): BotToolReceipt | undefined {
  if (!id.startsWith("bot-")) return
  const match = nativeId.exec(id)
  if (!match) return
  if (match[1] === "control") return match[3] ? undefined : { kind: "control" }
  if (match[3] && toolName.startsWith("bot_"))
    return { kind: match[1] === "recovery" ? "recovery" : "attempt", operation: toolName + ":" + match[2], attempt: Number(match[3]) }
  return undefined
}

export function isBotToolControlError(call: { id: string; name: string }, result: { content: unknown; is_error?: boolean; botReceipt?: BotToolReceipt }): boolean {
  const { content } = result
  if (!result.is_error || typeof content !== "string" || content.length > 4096) return false
  if (historicalControlErrors.has(content) && (call.name.startsWith("bot_") ||
      ["execute", "read_file", "write_file", "edit_file", "glob", "grep", "ls", "task", "request_user_input"].includes(call.name))) return true
  if (result.botReceipt?.kind !== "control") return false
  try {
    const receipt = JSON.parse(content)
    return receipt?.kind === "bot-tool-control" && receipt.version === 1 && receipt.executed === false && receipt.callId === call.id &&
      receipt.tool === call.name && Object.hasOwn(controlInstructions, receipt.reason)
  } catch {
    return false
  }
}

/** Announce a handoff only after its native receipt. Earlier tool prose is private. */
export function isBotHandoffCall(call: unknown): boolean {
  if (!call || typeof call !== "object" || !("name" in call)) return false
  if (call.name === "bot_skill_dispatch" || call.name === "bot_work_create" || call.name === "bot_work_send") return true
  if (call.name !== "bot_feature_update" || !("args" in call)) return false
  const args = call.args
  return !!args && typeof args === "object" && "action" in args &&
    ["session", "continue", "manage"].includes(String(args.action))
}

export function isBotContinuationReceipt(result?: {
  content?: unknown
  is_error?: boolean
}): boolean {
  if (result?.is_error || typeof result?.content !== "string") return false
  try {
    const value = JSON.parse(result.content)
    return (
      value?.kind === BOT_CONTINUATION_KIND &&
      value.version === 1 &&
      value.executed === false &&
      value.reason === "foreground_budget" &&
      typeof value.instruction === "string"
    )
  } catch {
    return false
  }
}

export interface BotDispatchFeedback {
  requestMessageId: string
  acknowledgement: string
  hadOpening: boolean
  /** Later visible findings must still reach IM; only the opening is deduplicated. */
  followup?: string
}
