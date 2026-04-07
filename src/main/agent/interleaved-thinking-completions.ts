import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import type { BaseMessage } from "@langchain/core/messages"
import type { ChatGenerationChunk } from "@langchain/core/outputs"
import { ChatOpenAICompletions } from "@langchain/openai"

function extractReasoningText(reasoning: unknown): string {
  if (typeof reasoning === "string") return reasoning
  if (Array.isArray(reasoning)) {
    return reasoning.map(extractReasoningText).filter(Boolean).join("")
  }
  if (reasoning && typeof reasoning === "object") {
    const record = reasoning as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (typeof record.reasoning === "string") return record.reasoning
    if (Array.isArray(record.parts)) return record.parts.map(extractReasoningText).filter(Boolean).join("")
  }
  return ""
}

function mergeReasoningIntoContent(content: unknown, reasoning: unknown): string {
  const contentText = typeof content === "string" ? content : ""
  const reasoningText = extractReasoningText(reasoning).trim()
  if (!reasoningText) return contentText
  if (contentText.startsWith("<think>")) return contentText

  const thinkBlock = `<think>${reasoningText}</think>`
  return contentText ? `${thinkBlock}\n${contentText}` : thinkBlock
}

export class InterleavedThinkingChatOpenAICompletions extends ChatOpenAICompletions {
  private thinkingOpen = false

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    this.thinkingOpen = false
    try {
      yield * super._streamResponseChunks(messages, options, runManager)
    } finally {
      this.thinkingOpen = false
    }
  }

  // Some OpenAI-compatible providers return reasoning outside content.
  // Convert it to the <think> format that the rest of the agent pipeline
  // already preserves across tool-call turns.
  override _convertCompletionsMessageToBaseMessage(
    ...args: Parameters<ChatOpenAICompletions["_convertCompletionsMessageToBaseMessage"]>
  ): ReturnType<ChatOpenAICompletions["_convertCompletionsMessageToBaseMessage"]> {
    const [message, rawResponse] = args
    const normalizedMessage = {
      ...message,
      content: mergeReasoningIntoContent(message.content, (message as { reasoning?: unknown }).reasoning)
    }
    return super._convertCompletionsMessageToBaseMessage(normalizedMessage, rawResponse)
  }

  override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]>
  ): ReturnType<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]> {
    const [delta, rawResponse, defaultRole] = args
    const reasoningText = extractReasoningText((delta as { reasoning?: unknown }).reasoning)
    const contentText = typeof delta.content === "string" ? delta.content : ""
    const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
    const shouldCloseThink =
      this.thinkingOpen &&
      (!reasoningText || reasoningText.length === 0) &&
      (contentText.length > 0 || hasToolCalls || rawResponse.choices?.[0]?.finish_reason != null)

    let nextContent = contentText
    if (reasoningText) {
      nextContent = `${this.thinkingOpen ? "" : "<think>"}${reasoningText}`
      if (contentText.length > 0 || hasToolCalls) {
        nextContent += `</think>${contentText.length > 0 ? `\n${contentText}` : ""}`
        this.thinkingOpen = false
      } else {
        this.thinkingOpen = true
      }
    } else if (shouldCloseThink) {
      nextContent = nextContent.length > 0 ? `</think>\n${nextContent}` : "</think>"
      this.thinkingOpen = false
    }

    return super._convertCompletionsDeltaToBaseMessageChunk(
      {
        ...delta,
        content: nextContent
      },
      rawResponse,
      defaultRole
    )
  }
}
