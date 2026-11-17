import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { randomUUID } from "node:crypto"
import type { BotDispatchFeedback } from "../../shared/bots/turn-feedback"
import { currentBotReplyState } from "./opening-reply-reminder"
import { BOT_SKILL_DISPATCH_TOOL } from "./bot-skill-dispatch"

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim()

function readDispatchReceipt(name: string, result: unknown): Record<string, unknown> | undefined {
  const message = record(result) ? result : undefined
  if (message?.status === "error" || message?.is_error) return
  try {
    const value = JSON.parse(typeof result === "string" ? result : String(message?.content ?? ""))
    if (value?.kind === "bot-work-receipt" && value.operation === name && record(value.receipt))
      return value.receipt
  } catch {
    /* Not a native successful receipt. */
  }
  return undefined
}

/** Use the accepted task's origin, including name lookups and replayed receipts. */
function skillDispatchAcknowledgement(result: unknown): string {
  const receipt = readDispatchReceipt(BOT_SKILL_DISPATCH_TOOL, result)
  const origin = record(receipt?.task) ? receipt.task.origin : undefined
  if (record(origin) && origin.kind === "work") {
    if (origin.dispatch === "create")
      return "已新建任务，我会按所选技能处理，结果发回这里。"
    if (origin.dispatch === "follow_up")
      return "我会在原任务中继续处理，结果发回这里。"
  }
  // Legacy receipts without an origin cannot prove whether this is a new task.
  return "我会按所选技能处理，结果发回这里。"
}

/** Native receipts only. A reopened business task or a starting/failed Feature is not accepted execution. */
export function acceptedBotDispatch(name: string, args: unknown, result: unknown): boolean {
  const receipt = readDispatchReceipt(name, result)
  if (!receipt) return false
  try {
    const acceptedTask = (task: unknown) =>
      record(task) &&
      nonempty(task.id) &&
      nonempty(task.workId) &&
      nonempty(task.threadId) &&
      typeof task.state === "string" &&
      ["queued", "running", "waiting_user", "completed"].includes(task.state)
    if (name === "bot_work_create" || name === BOT_SKILL_DISPATCH_TOOL)
      return (
        acceptedTask(receipt.task) &&
        record(receipt.task) &&
        record(receipt.work) &&
        nonempty(receipt.work.id) &&
        !(name === BOT_SKILL_DISPATCH_TOOL && record(args) && args.workId && args.workId !== receipt.work.id) &&
        receipt.task.workId === receipt.work.id &&
        receipt.task.threadId === receipt.work.threadId &&
        receipt.task.botId === receipt.work.botId
      )
    if (name === "bot_work_send")
      return acceptedTask(receipt) && record(args) && receipt.workId === args.workId
    if (
      name === "bot_feature_update" &&
      record(args) &&
      typeof args.action === "string" &&
      ["session", "continue", "manage"].includes(args.action)
    ) {
      const operation = receipt.operation
      return (
        record(operation) &&
        nonempty(operation.id) &&
        operation.action === args.action &&
        typeof operation.state === "string" &&
        ["active", "finished"].includes(operation.state) &&
        !operation.error &&
        nonempty(args.action === "manage" ? operation.runId : operation.threadId)
      )
    }
  } catch {
    /* Not a native successful receipt. */
  }
  return false
}

/** Bounded by the latest visible request; a new steer or internal result always needs a fresh model turn. */
export function botDispatchFeedback(
  messages: readonly BaseMessage[]
): BotDispatchFeedback | undefined {
  let callIndex = messages.length - 1
  const results = new Map<string, ToolMessage>()
  while (callIndex >= 0 && ToolMessage.isInstance(messages[callIndex])) {
    const message = messages[callIndex] as ToolMessage
    if (results.has(message.tool_call_id)) return undefined
    results.set(message.tool_call_id, message)
    callIndex--
  }
  const assistant = messages[callIndex]
  if (!AIMessage.isInstance(assistant) || !assistant.tool_calls?.length) return
  const calls = assistant.tool_calls
  // The model explicitly closes its dispatch batch. Without this flag it may
  // still owe another destination, an immediate answer or a clarification.
  if (!calls.some((call) => call.args.finishTurn === true || call.name === BOT_SKILL_DISPATCH_TOOL) || results.size !== calls.length) return
  if (
    !calls.every(
      (call) => call.id && acceptedBotDispatch(call.name, call.args, results.get(call.id))
    )
  )
    return
  const state = currentBotReplyState(messages)
  if (!state?.requestMessageId || state.internalInput) return undefined
  const skillCall = calls.find(call => call.name === BOT_SKILL_DISPATCH_TOOL)
  return {
    requestMessageId: state.requestMessageId,
    hadOpening: !!state.opening,
    ...(state.followup ? { followup: state.followup } : {}),
    acknowledgement: state.opening || (skillCall
      ? skillDispatchAcknowledgement(results.get(skillCall.id!)) : "我会继续处理，结果会发回这里。")
  }
}

/** After the steer queue, before the next model call. No synthetic hidden assistant turn. */
export function createBotDispatchFeedbackMiddleware(
  onFeedback: (feedback: BotDispatchFeedback | undefined) => void
) {
  return createMiddleware({
    name: "botDispatchFeedback",
    beforeModel: {
      canJumpTo: ["end"],
      hook: (state) => {
        const feedback = botDispatchFeedback(state.messages)
        onFeedback(feedback)
        if (!feedback) return undefined
        return {
          ...(!feedback.hadOpening
            ? {
                messages: [
                  new AIMessage({
                    id: `bot-dispatch-${randomUUID()}`,
                    content: feedback.acknowledgement,
                    response_metadata: { finish_reason: "stop" }
                  })
                ]
              }
            : {}),
          jumpTo: "end" as const
        }
      }
    }
  })
}
