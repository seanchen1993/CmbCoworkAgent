import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod"
import { isWorkflowPlumbingTranscriptContent } from "../../shared/checkpoint-transcript"
import { botTaskGroupId, type BotTask } from "../../shared/bots/contracts"
import { isBotGroupPass } from "../../shared/bots/group-discussion"
import { isBotRoutineSilent } from "../../shared/bots/routine-silence"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"
import type { LocalBotHost } from "./host"
import { extractVisibleText, type TurnFinalDeliveryCheck } from "../agent/turn-completion-integrity"
import { MAIN_TURN_ONLY_TOOL_METADATA_KEY } from "../agent/runtime-tool-catalog"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"

/** Grok's SendMessage boundary, using the existing local room and Runtime tool receipts. */
export function createBotGroupMessageTool(
  task: BotTask,
  getHost: () => LocalBotHost,
  signal: AbortSignal,
  sent: (content: string) => void
) {
  const currentGroupId = botTaskGroupId(task)
  const contentSchema = z.string().trim().min(1).max(60_000)
  return tool(
    async (input, config) => {
      const { content } = input
      signal.throwIfAborted()
      try {
        if (getHookAgentIdFromRequest(config))
          throw new Error(
            "Temporary task agents return results to their parent; only the parent Bot sends group messages."
          )
        // Grok filters SendMessage("(pass)") before it enters the public room.
        // Direct user answers keep their literal text; only optional turns may abstain.
        if (
          (task.origin.kind === "discussion" ||
            (task.origin.kind === "bot" && !task.origin.expectsReply)) &&
          isBotGroupPass(content)
        )
          return JSON.stringify({
            kind: "bot-group-pass",
            taskId: task.id,
            groupId: botTaskGroupId(task)
          })
        const receipt = currentGroupId
          ? getHost().publishGroupMessage(task.id, config.toolCall?.id ?? "", content)
          : getHost().publishGroupMessage(
              task.id,
              config.toolCall?.id ?? "",
              content,
              "groupId" in input && typeof input.groupId === "string" ? input.groupId : undefined
            )
        // A public post from private chat does not replace its private final reply.
        if (currentGroupId) sent(content)
        return JSON.stringify({ kind: "bot-group-message", taskId: task.id, ...receipt })
      } catch (cause) {
        signal.throwIfAborted()
        const content = JSON.stringify({
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause)
        })
        return new ToolMessage({
          content,
          status: "error",
          name: "bot_send_message",
          tool_call_id: config.toolCall?.id ?? ""
        })
      }
    },
    {
      name: "bot_send_message",
      metadata: { [MAIN_TURN_ONLY_TOOL_METADATA_KEY]: true },
      description: currentGroupId
        ? "Send a real standalone text message to the current shared group. Ordinary assistant text and private collaboration results are not posted. Use this for concise replies, meaningful progress, and text-only results; an acknowledgement is not the result. For public handoffs, address @ followed by a current member's exact name in content; the existing room routes that mention after your turn. Do not also privately delegate that same public handoff. Use bot_deliver_files for real attachments and request_user_input for decisions. Do not relay a peer result already visible in the room unless the user assigned you further analysis or integration. A successful receipt means this message was posted, not that the task's acceptance criteria passed."
        : "Post one real text message as this Bot to an existing group the user explicitly asked you to contact. Supply its exact host-confirmed groupId, never a name or Bot ID. Group posting can wake members: do not fan out or share private conversation unless the user explicitly requested that audience and content; ask first when this is missing. Only content is published, not the private request or history. For public handoffs use @ followed by a current member's exact name; do not also privately delegate the same work. A receipt confirms posting, not member answers or task completion. Report the actual result privately. This text tool does not attach files or move private question cards into the group.",
      schema: currentGroupId
        ? z.object({ content: contentSchema }).strict()
        : z.object({ content: contentSchema, groupId: z.string().uuid() }).strict()
    }
  )
}

/** Only actual tool receipts in the latest user boundary satisfy formal delivery. */
export function createBotGroupDeliveryCheck(
  task: BotTask,
  peerDeliveryPosted = false
): TurnFinalDeliveryCheck {
  const groupId = botTaskGroupId(task)
  const mayPass =
    task.origin.kind === "discussion" ||
    (task.origin.kind === "bot" && !task.origin.expectsReply && peerDeliveryPosted)
  return (messages: readonly BaseMessage[]) => {
    let start = 0
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (
        HumanMessage.isInstance(message) &&
        !isWorkflowPlumbingTranscriptContent(message.content)
      ) {
        start = i + 1
        break
      }
    }
    const calls = new Map<string, string>()
    for (let i = start; i < messages.length; i++) {
      const message = messages[i]
      if (AIMessage.isInstance(message))
        for (const call of message.tool_calls ?? []) if (call.id) calls.set(call.id, call.name)
      if (
        !ToolMessage.isInstance(message) ||
        message.status === "error" ||
        typeof message.content !== "string"
      )
        continue
      const name = calls.get(message.tool_call_id)
      if (name === "bot_deliver_files" && parseBotFileDelivery(message.content)) return undefined
      if (name !== "bot_send_message" && name !== "bot_delegate") continue
      try {
        const receipt = JSON.parse(message.content)
        if (
          name === "bot_send_message" &&
          mayPass &&
          receipt.kind === "bot-group-pass" &&
          receipt.taskId === task.id &&
          receipt.groupId === groupId
        )
          return undefined
        // A real asynchronous handoff owes its result on the existing return turn.
        // Forcing this foreground turn to speak creates the redundant waiting acknowledgement.
        if (
          name === "bot_delegate" &&
          typeof receipt.taskId === "string" &&
          receipt.taskId &&
          typeof receipt.botId === "string" &&
          receipt.botId &&
          receipt.state === "queued"
        )
          return undefined
        if (
          name === "bot_send_message" &&
          receipt.kind === "bot-group-message" &&
          receipt.taskId === task.id &&
          receipt.groupId === groupId &&
          typeof receipt.messageId === "string" &&
          receipt.messageId
        )
          return undefined
      } catch {
        /* An invalid receipt is not a delivery. */
      }
    }
    const final = messages.at(-1)
    const body =
      final && AIMessage.isInstance(final)
        ? splitBotInlineReasoning(extractVisibleText(final.content)).body.trim()
        : ""
    // Internal work still owes its parent a useful result, not a forced public message.
    if (task.origin.kind === "bot" && task.origin.expectsReply)
      return body && !isBotGroupPass(body)
        ? undefined
        : "Return a useful private result or concrete blocker to the delegating Bot using the existing results. Only use bot_send_message when a public room contribution is actually needed; do not repeat completed actions."
    if (mayPass && isBotGroupPass(body)) return undefined
    if (
      task.origin.kind === "notification" &&
      task.origin.notificationKind === "command" &&
      task.origin.commandSucceeded === true &&
      isBotRoutineSilent(body)
    )
      return undefined
    return (
      "Use bot_send_message to post the actual reply to this shared group, or bot_deliver_files for requested attachments. Plain assistant text is private and does not reach the room. Use verified existing results; do not redo completed actions." +
      (mayPass
        ? " If this optional/internal turn owes no new public contribution, return exactly (pass)."
        : " The host has not confirmed a public reply for this result; plain text and a pass marker do not satisfy delivery.")
    )
  }
}
