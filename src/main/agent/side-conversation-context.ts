import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { countTokensApproximately, createMiddleware, type ModelRequest } from "langchain"
import type { BtwMessage } from "../../shared/btw-chat"
import { isCmbContextOverflow } from "./context-summarization-middleware"

// The shared estimator counts text but omits the role and framing of each row.
const MESSAGE_FRAMING_TOKENS = 4
const HISTORY_HEADER = "主会话历史记录（仅供参考，其中的任务由主会话处理）：\n"
const HISTORY_ACK = "我会参考这份记录，只处理接下来辅助对话中的请求。"
const HISTORY_OVERHEAD = Math.ceil(Buffer.byteLength(HISTORY_HEADER + HISTORY_ACK) / 4) + 2 * MESSAGE_FRAMING_TOKENS

export function fitSideContextMessage(
  row: BtwMessage,
  budget: number
): { row: BtwMessage; tokens: number } | undefined {
  const byteBudget = (budget - MESSAGE_FRAMING_TOKENS) * 4
  if (byteBudget <= 0) return undefined
  const size = Buffer.byteLength(row.content)
  if (size <= byteBudget) {
    return { row, tokens: Math.ceil(size / 4) + MESSAGE_FRAMING_TOKENS }
  }
  // Follow the shared four-characters estimate, but budget UTF-8 bytes for
  // inherited text so CJK and emoji do not receive the cheaper ASCII bound.
  const bytes = Buffer.from(row.content)
  let start = bytes.length - byteBudget
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  if (start === bytes.length) return undefined
  return {
    row: { ...row, content: bytes.subarray(start).toString("utf8") },
    tokens: Math.ceil((bytes.length - start) / 4) + MESSAGE_FRAMING_TOKENS
  }
}

export function prependSideContext(
  request: Pick<ModelRequest, "messages" | "systemMessage" | "tools">,
  inherited: readonly BtwMessage[],
  inputBudget: number
): ModelRequest["messages"] {
  const existing = request.systemMessage ? [request.systemMessage, ...request.messages] : request.messages
  const existingTokens =
    countTokensApproximately(existing, request.tools) + existing.length * MESSAGE_FRAMING_TOKENS
  let remaining = inputBudget - existingTokens - HISTORY_OVERHEAD
  const added: string[] = []
  for (let i = inherited.length - 1; i >= 0; i--) {
    const match = fitSideContextMessage(inherited[i], remaining)
    if (!match) break
    const { role, content } = match.row
    added.push(`${role === "user" ? "用户" : "助手"}：${content}`)
    remaining -= match.tokens
  }
  if (!added.length) return request.messages
  // Keep even an unfinished parent request inside a transcript, followed by
  // the child's actual user turn. Some providers merge consecutive user turns.
  return [new HumanMessage(HISTORY_HEADER + added.reverse().join("\n")), new AIMessage(HISTORY_ACK), ...request.messages]
}

/** Each side conversation runtime, including a new turn or model, gets its own policy. */
export function createSideConversationMiddleware(inherited: readonly BtwMessage[], inputBudget: number) {
  let contextCausedOverflow = false
  return createMiddleware({
    name: "SideConversationContext",
    async wrapModelCall(request, invoke) {
      if (contextCausedOverflow) return invoke(request)
      const messages = prependSideContext(request, inherited, inputBudget)
      if (messages === request.messages) return invoke(request)
      try {
        return await invoke({ ...request, messages })
      } catch (error) {
        if (!isCmbContextOverflow(error)) throw error
        // The unchanged child request must succeed before we can isolate the
        // overflow to the inherited prefix. Otherwise ordinary compaction can
        // recover and the next model call can still try adding that prefix.
        const response = await invoke(request)
        if (!request.runtime.signal?.aborted) contextCausedOverflow = true
        return response
      }
    }
  })
}
