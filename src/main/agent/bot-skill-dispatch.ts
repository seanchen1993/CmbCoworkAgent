import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { createMiddleware } from "langchain"
import type { BotTask } from "../../shared/bots/contracts"
import { parseSkillUseBlock } from "./skill-lifecycle/marker"

export const BOT_SKILL_DISPATCH_TOOL = "bot_skill_dispatch"
export interface BotSkillDispatch {
  name: string
  path: string
  block: string
}

/** Only a local main-Bot composer selection. Task, project and remote text keep their existing behavior. */
export function selectedMainBotSkill(task: BotTask): BotSkillDispatch | undefined {
  if (task.workId || task.mockSource || task.origin.kind !== "user") return
  if (task.origin.explicitSkill) return { ...task.origin.explicitSkill, block: "" }
  const selected = parseSkillUseBlock(task.message)
  return selected ? { name: selected.skillName, path: selected.skillPath, block: selected.block } : undefined
}

/** Preserve the stored/visible source; the dispatcher must not receive the executor's read-SKILL instruction. */
export function botSkillDispatchInput(input: string, selection: BotSkillDispatch): string {
  return input.replace(selection.block, "").trimEnd() +
    `\n\n<bot_skill_dispatch>\nThe user explicitly selected skill ${JSON.stringify(selection.name)}. ` +
    "Call bot_skill_dispatch now, with arguments only and no preliminary reply. Choose the destination, not whether to delegate. " +
    "Reuse the existing workId for a revision/continuation (or workQuery if its ID is absent); otherwise supply a short title. " +
    "Honor an explicitly designated directory or project; omit workspace for the default. " +
    "Do not read the skill or business files, run commands, plan the implementation or repeat the original request in the goal. " +
    "The host supplies the original request and activates the selected skill in the task. " +
    "After successful acceptance the host acknowledges once and ends this turn. If dispatch fails, explain the actual blocker briefly; never claim it started.\n</bot_skill_dispatch>"
}

/** Stable schemas, forced destination call, and a host gate before hooks or filesystem access. */
export function createBotSkillDispatchMiddleware() {
  let attempted = false
  return createMiddleware({
    name: "botSkillDispatch",
    wrapModelCall: async (request, handler) => {
      const selecting = !attempted
      const result = await handler({
        ...request,
        toolChoice: selecting ? { type: "function", function: { name: BOT_SKILL_DISPATCH_TOOL } } : "none"
      })
      if (!selecting) return result
      if (!AIMessage.isInstance(result) || result.tool_calls?.length !== 1 ||
          result.tool_calls[0].name !== BOT_SKILL_DISPATCH_TOOL)
        throw new Error("技能任务尚未启动：模型未返回有效的交办请求，请重试。")
      // The short routing model does not stream. Acknowledgement belongs to the
      // accepted host receipt, never to unverified prose accompanying arguments.
      return new AIMessage({ ...result, content: "" })
    },
    wrapToolCall: (request, handler) => {
      if (attempted || request.toolCall.name !== BOT_SKILL_DISPATCH_TOOL) {
        attempted = true
        return new ToolMessage({
          name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: "error",
          content: "The selected-skill dispatch did not execute this call. Only one bot_skill_dispatch call is allowed in this main turn. Explain the actual blocker; do not perform the work here or claim acceptance without its receipt."
        })
      }
      attempted = true
      return handler(request)
    }
  })
}
