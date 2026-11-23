import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import { randomUUID } from "node:crypto"
import type { BotDispatchFeedback } from "../../shared/bots/turn-feedback"
import { currentBotReplyState } from "./opening-reply-reminder"
import { BOT_SKILL_DISPATCH_TOOL } from "./bot-skill-dispatch"
import { isSavedBotSkillSchedule } from "../../shared/bots/skill-selection"

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

/** Invalid optional display text never invalidates an otherwise accepted task. */
function shortHandoffText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return
  const text = value.trim()
  if (text && text.length <= limit && !/[\r\n\u2028\u2029]|\b(?:finishTurn|remainingRequest|bot_[a-z]\w*)\b/iu.test(text)) return text
  return undefined
}

type HandoffKind = "new" | "continue" | "scheduled"

/** Presentation never chooses the actual destination, status or next run time. */
function acceptedConfirmation(
  call: NonNullable<AIMessage["tool_calls"]>[number],
  result: ToolMessage,
  english: boolean
): string {
  const receipt = readDispatchReceipt(call.name, result)!
  const schedule = isSavedBotSkillSchedule(receipt.schedule) ? receipt.schedule : undefined
  const origin = record(receipt.task) && record(receipt.task.origin) ? receipt.task.origin : undefined
  let kind: HandoffKind | undefined
  if (schedule) kind = "scheduled"
  else if (call.name === "bot_work_send" || origin?.dispatch === "follow_up" ||
      (call.name === "bot_feature_update" && call.args.action === "continue")) kind = "continue"
  else if (call.name === "bot_work_create" || origin?.dispatch === "create" ||
      call.name === "bot_feature_update") kind = "new"

  let next = schedule?.nextRunAt
  if (schedule) {
    try {
      next = new Date(schedule.nextRunAt).toLocaleString(english ? "en-US" : "zh-CN", {
        timeZone: schedule.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
      })
    } catch { /* Use the host's ISO time if the local runtime does not recognize its timezone. */ }
  }
  const draft = call.args.confirmation
  if (kind && record(draft) && draft.kind === kind) {
    const text = shortHandoffText(draft.text, 160)
    // A stale client or model can propose a receipt for a different operation, leak controls,
    // or claim a later lifecycle state. Fall back to the native facts for the whole sentence.
    if (text && !/[<>]|https?:\/\/|(?:前台预算|后台代理|执行预算|工具调用|已(?:经)?(?:完成|生成|发出|交付|发送|在运行|开始执行)|正在运行)|\b(?:foreground budget|tool call|already (?:running|finished|sent)|has (?:finished|completed)|I(?:'ve| have) (?:finished|sent|completed))\b/iu.test(text) &&
        !/[。！？!?]\s*\S/u.test(text) && !/\.\s+[\p{Lu}]/u.test(text) &&
        (next ? text.split("{nextRun}").length === 2 : !text.includes("{nextRun}"))) {
      return next ? text.replace("{nextRun}", next) : text
    }
  }
  if (schedule) return english ? `Scheduled “${schedule.name}”. Next run: ${next}.` :
    `已安排「${schedule.name}」，下次执行时间是 ${next}。`
  const subject = record(receipt.work) ? shortHandoffText(receipt.work.title, 64) : undefined
  if (kind === "continue") return english
    ? "I'll update the original task and send the result here."
    : subject ? `我会接着处理原任务「${subject}」，结果发回这里。` : "我会在原任务中继续处理，结果发回这里。"
  if (subject) return english ? `I'll take care of “${subject}” and send the result here.` : `我来处理「${subject}」，结果发回这里。`
  return english ? "I'll take care of this and send the result here." : "我来处理这件事，结果发回这里。"
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
    if (name === BOT_SKILL_DISPATCH_TOOL && record(args) && args.schedule)
      return isSavedBotSkillSchedule(receipt.schedule, args.workId)
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

/** The assigned reply already returns to its source. Only a distinct, user-authored
 * instruction can keep the foreground turn open after native acceptance. */
export function hasOutstandingBotRequest(args: Record<string, unknown>, userText: string): boolean {
  if (args.finishTurn === false) return true // Historical in-flight tool calls.
  if (!nonempty(args.remainingRequest)) return false
  const normalize = (text: string) => text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()
  const quote = normalize(args.remainingRequest).replace(/^[“「"]|[”」"]$/gu, "")
  const source = normalize(userText)
  if (!quote || source === quote || !source.includes(quote)) return false
  // Returning the outcome to this chat is part of the native receipt.
  const replyHere = /^(?:请)?(?:直接)?(?:在这里|在群里|在本群|在本对话中?|在此)?(?:回复|答复|发回|发到)(?:这里|本群|群里|给我)?(?:即可|就行)?[。.!！]?$/u
  const replyHereEnglish = /^(?:please )?(?:reply|respond|report back|send (?:it|the result)(?: back)?) (?:right )?(?:here|in this (?:chat|group|conversation))[.!]?$/u
  return !replyHere.test(quote) && !replyHereEnglish.test(quote)
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
  // A verified dispatch is terminal unless the caller still owes another step.
  if (results.size !== calls.length) return
  if (
    !calls.every(
      (call) => call.id && acceptedBotDispatch(call.name, call.args, results.get(call.id))
    )
  )
    return
  const state = currentBotReplyState(messages)
  if (!state?.requestMessageId || state.internalInput) return undefined
  if (calls.some(call => hasOutstandingBotRequest(call.args, state.requestText))) return
  const english = !/\p{Script=Han}/u.test(state.requestText) && /[A-Za-z]{2}/u.test(state.requestText)
  const first = calls[0]
  const acknowledgement = state.opening || (calls.length === 1
    ? acceptedConfirmation(first, results.get(first.id!)!, english)
    : english ? `I'll take care of these ${calls.length} items and send the results here.` : `这 ${calls.length} 项工作我接下了，结果会发到这里。`)
  const finding = state.hasEvidence ? calls.map(call => shortHandoffText(call.args.finding, 120)).find(Boolean) : undefined
  return {
    requestMessageId: state.requestMessageId,
    hadOpening: !!state.opening,
    ...(finding ? { followup: state.opening ? finding : `${finding} ${acknowledgement}` } : {}),
    acknowledgement
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
          ...(!feedback.hadOpening || feedback.followup
            ? {
                messages: [
                  new AIMessage({
                    id: `bot-dispatch-${randomUUID()}`,
                    content: feedback.followup ?? feedback.acknowledgement,
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
