import { tool } from "@langchain/core/tools"
import { botSendMessageInput } from "../../shared/bot-send-message"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { BotDocumentReader } from "./document-reader"

/** Uses the existing graph, lease and object locks; committing a message never
 * queues another run or ends this turn. Lost acknowledgements reuse toolOnce. */
export function botSendMessageTool(
  request: BotRuntimeRequest,
  check: () => void,
  files?: BotArtifacts,
  reader?: Pick<BotDocumentReader, "image">,
  options: { textOnly?: boolean } = {}
) {
  const { store, lease, signal } = request
  const schema = options.textOnly
    ? botSendMessageInput.pick({ content: true })
    : botSendMessageInput
  return tool(
    async (input, call) => {
      check()
      const id = call.toolCall?.id
      if (!id) throw new BotDomainError("tool_call_identity", "发送消息缺少稳定执行标识")
      const normalized = botSendMessageInput.parse(schema.parse(input))
      const send = () => {
        check()
        return JSON.stringify(store.sendMessage(lease, id, normalized))
      }
      // Receipt input verification still runs; an acknowledged image need not
      // remain readable to return its original delivery receipt after restart.
      if (store.hasToolResult(lease, id) || !normalized.images?.length) return send()
      if (!files || !reader)
        throw new BotDomainError("files_unavailable", "文件服务未连接，无法发送图片")
      const images = store.peerImageSources(lease, normalized.images)
      return files.withPeerImages(lease, images, check, send, async (bytes) => {
        await reader.image(bytes, undefined, signal)
        check()
      })
    },
    {
      name: "send_message",
      description:
        (options.textOnly
          ? "Publish a brief text progress message in the current assigned demonstration-learning conversation, then continue reading the recording and saving its skill. Report meaningful learning stages or limitations; sending progress does not complete learning or replace save_taught_skill. Do not include images, quoted replies, passwords, tokens or other secrets; use the existing question tools for missing information. Your final assistant response is still delivered automatically. Returns the stable delivered messageId."
          : "Publish a durable message to the user in this task's current conversation and discussion branch, then continue the same turn. Use it for a meaningful intermediate result, decision or blocker; keep updates brief and avoid narrating routine mechanics. It neither starts another task nor asks a question or grants permission. Your final assistant response is still delivered automatically, so do not repeat an already sent update. Optional images are explicitly selected PNG/JPEG/WebP/GIF artifact IDs visible to this task or produced by it, not paths or URLs; they render below this message with their alt text. Optional reply_to is the exact ID of an earlier visible message in this same discussion, or a message this tool already sent; quoting does not create a branch. Never request or include passwords, API keys or other secrets here: use the existing secure input or computer-help flow. Returns the stable delivered messageId, not a task-completion receipt.") +
        ` Current task input message ID: ${request.run.messageId}.`,
      schema
    }
  )
}
