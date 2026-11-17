import { createMiddleware } from "langchain"
import { ToolMessage } from "@langchain/core/messages"

/** Per physical main-chat turn. Never inherited by a worker or persisted as a user preference. */
export interface ForegroundWorkBudget {
  beforeTool(name: string, args: unknown): string | undefined
  afterTool(name: string, result: unknown, args?: unknown): void
  checkFinal(): string | undefined
  yieldCommand(): void
}

const COORDINATION = new Set([
  "request_user_input",
  "bot_request_browser_help",
  "write_todos",
  "bot_work_create",
  "bot_work_send",
  "bot_work_continue",
  "bot_work_complete",
  "bot_work_list",
  "bot_work_read",
  "bot_work_search",
  "bot_work_projects",
  "bot_feature_list",
  "bot_feature_read",
  "bot_feature_update",
  "bot_send_message",
  "bot_group_list",
  "bot_group_send_message",
  "bot_memory_search",
  "bot_memory_list",
  "bot_memory_get",
  "bot_remember",
  "bot_forget",
  "bot_update_profile",
  "bot_update_teammate",
  "bot_create_teammate",
  "bot_react_to_message",
  "bot_schedule",
  "bot_list_peers",
  "bot_delegate"
])
const HANDOFF = new Set(["bot_work_create", "bot_work_send", "bot_feature_update"])
const NOTICE =
  "Foreground execution budget reached. This tool has NOT run. Keep the main chat available: hand the remaining assignment to bot_work_create, or continue its existing task/Feature. Include the user's goal and constraints, selected workspace, completed findings and exact command receipts; do not repeat completed actions or restart an accepted background command. Then briefly tell the user where the work continues. Do not poll or work around this boundary with another tool."

export function createForegroundWorkBudget(options: {
  yieldCommand(): void
  now?: () => number
  maxOperations?: number
  maxDurationMs?: number
}): ForegroundWorkBudget {
  const now = options.now ?? Date.now
  let started: number | undefined
  let operations = 0
  let handoffRequired = false
  let handedOff = false
  return {
    beforeTool(name, args) {
      if (
        COORDINATION.has(name) ||
        name.startsWith("bot_schedule_") ||
        (name === "bot_browser" && (args as { action?: string } | null)?.action === "request_help")
      )
        return
      // A synchronous child/workflow blocks the caller for its entire lifetime.
      // Persistent work is the asynchronous executor available to a main Bot.
      const exhausted =
        name === "task" ||
        name === "workflow" ||
        operations >= (options.maxOperations ?? 4) ||
        (started !== undefined && now() - started >= (options.maxDurationMs ?? 30_000))
      if (handoffRequired || exhausted) {
        if (!handoffRequired) handedOff = false
        handoffRequired = true
        return NOTICE
      }
      started ??= now()
      operations++
      return undefined
    },
    afterTool(name, result, args) {
      if (!handoffRequired || !HANDOFF.has(name)) return
      if (
        name === "bot_feature_update" &&
        !["session", "continue", "manage"].includes(
          (args as { action?: string } | undefined)?.action ?? ""
        )
      )
        return
      const message = result as { status?: string; content?: unknown } | null
      if (message?.status === "error") return
      try {
        const value = JSON.parse(
          typeof result === "string" ? result : String(message?.content ?? "")
        )
        if (value?.kind === "bot-work-receipt" && value.operation === name && value.receipt)
          handedOff = true
      } catch {
        /* An unverified or failed receipt never completes handoff. */
      }
    },
    checkFinal: () => (handoffRequired && !handedOff ? NOTICE : undefined),
    yieldCommand: options.yieldCommand
  }
}

/** Runs before workspace locks and hooks. Rejected operations have no side effects. */
export function createForegroundWorkBudgetMiddleware(budget: ForegroundWorkBudget) {
  return createMiddleware({
    name: "foregroundWorkBudget",
    wrapToolCall: async (request, handler) => {
      const call = request.toolCall
      const notice = budget.beforeTool(call.name, call.args)
      if (notice)
        return new ToolMessage({
          name: call.name,
          tool_call_id: call.id!,
          status: "error",
          content: notice
        })
      // Transfer the very same process through the sandbox's durable command
      // lifecycle. This neither kills it nor launches a replacement command.
      const timer =
        call.name === "execute" ? setInterval(() => budget.yieldCommand(), 10_000) : undefined
      try {
        const result = await handler(request)
        budget.afterTool(call.name, result, call.args)
        return result
      } finally {
        clearInterval(timer)
      }
    }
  })
}
