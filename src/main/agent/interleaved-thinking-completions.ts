import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import type { BaseMessage } from "@langchain/core/messages"
import type { ChatGenerationChunk } from "@langchain/core/outputs"
import { ChatOpenAICompletions } from "@langchain/openai"

const THINK_OPEN_TAG = "<think>"
const THINK_CLOSE_TAG = "</think>"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function extractReasoningText(reasoning: unknown): string {
  if (typeof reasoning === "string") return reasoning
  if (Array.isArray(reasoning)) {
    return reasoning.map(extractReasoningText).filter(Boolean).join("")
  }
  if (reasoning && typeof reasoning === "object") {
    const record = reasoning as Record<string, unknown>
    if (typeof record.text === "string") return record.text
    if (typeof record.reasoning === "string") return record.reasoning
    if (typeof record.reasoning_content === "string") return record.reasoning_content
    if (typeof record.reasoning_text === "string") return record.reasoning_text
    if (typeof record.content === "string") return record.content
    if (typeof record.summary === "string") return record.summary
    if (typeof record.delta === "string") return record.delta
    if (Array.isArray(record.parts))
      return record.parts.map(extractReasoningText).filter(Boolean).join("")
    if (Array.isArray(record.reasoning_details)) {
      return record.reasoning_details.map(extractReasoningText).filter(Boolean).join("")
    }
    if (Array.isArray(record.summary))
      return record.summary.map(extractReasoningText).filter(Boolean).join("")
    if (Array.isArray(record.details))
      return record.details.map(extractReasoningText).filter(Boolean).join("")
  }
  return ""
}

function extractReasoningFromRecord(record: Record<string, unknown>): string {
  const additionalKwargs = asRecord(record.additional_kwargs)
  return extractReasoningText(
    record.reasoning ??
      record.reasoning_content ??
      record.reasoning_text ??
      record.reasoning_details ??
      record.summary ??
      record.details ??
      record.delta ??
      additionalKwargs?.reasoning ??
      additionalKwargs?.reasoning_content ??
      additionalKwargs?.reasoning_text ??
      additionalKwargs?.reasoning_details ??
      additionalKwargs?.summary ??
      additionalKwargs?.details ??
      additionalKwargs?.delta
  )
}

function attachReasoningToAdditionalKwargs<T>(message: T, reasoning: string): T {
  if (!reasoning) return message
  const reasoningText = reasoning

  const writableMessage = message as {
    additional_kwargs?: Record<string, unknown>
    lc_kwargs?: { additional_kwargs?: Record<string, unknown> }
  }
  const additionalKwargs = asRecord(writableMessage.additional_kwargs) ?? {}
  writableMessage.additional_kwargs = {
    ...additionalKwargs,
    reasoning: reasoningText
  }

  if (writableMessage.lc_kwargs) {
    const lcAdditionalKwargs = asRecord(writableMessage.lc_kwargs.additional_kwargs) ?? {}
    writableMessage.lc_kwargs = {
      ...writableMessage.lc_kwargs,
      additional_kwargs: {
        ...lcAdditionalKwargs,
        reasoning: reasoningText
      }
    }
  }

  return message
}

function hasThinkOpenTag(text: string): boolean {
  return text.includes(THINK_OPEN_TAG)
}

function hasThinkCloseTag(text: string): boolean {
  return text.includes(THINK_CLOSE_TAG)
}

function startsWithThinkTag(text: string): boolean {
  return text.trimStart().startsWith(THINK_OPEN_TAG)
}

function resolveThinkOpenState(initialState: boolean, text: string): boolean {
  let thinkingOpen = initialState
  const tagPattern = /<\/?think>/g
  let match: RegExpExecArray | null = null

  while ((match = tagPattern.exec(text)) !== null) {
    thinkingOpen = match[0] === THINK_OPEN_TAG
  }

  return thinkingOpen
}

function normalizeReasoningBlock(reasoning: unknown): string {
  const reasoningText = extractReasoningText(reasoning).trim()
  if (!reasoningText) return ""

  if (hasThinkOpenTag(reasoningText)) {
    return resolveThinkOpenState(false, reasoningText)
      ? `${reasoningText}${THINK_CLOSE_TAG}\n\n`
      : reasoningText
  }

  return `${THINK_OPEN_TAG}${reasoningText}${THINK_CLOSE_TAG}\n\n`
}

function mergeReasoningIntoContent(content: unknown, reasoning: unknown): string {
  const contentText = typeof content === "string" ? content : ""
  const reasoningBlock = normalizeReasoningBlock(reasoning)
  if (!reasoningBlock) return contentText
  if (startsWithThinkTag(contentText)) return contentText

  return contentText ? `${reasoningBlock}\n${contentText}` : reasoningBlock
}

export class InterleavedThinkingChatOpenAICompletions extends ChatOpenAICompletions {
  private thinkingOpen = false
  private readonly exposeReasoning: boolean

  constructor(fields?: unknown, options?: { exposeReasoning?: boolean }) {
    super(fields as never)
    this.exposeReasoning = options?.exposeReasoning === true
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    this.thinkingOpen = false
    try {
      yield* super._streamResponseChunks(messages, options, runManager)
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
    try {
      const [message, rawResponse] = args
      const reasoning = extractReasoningFromRecord(message as unknown as Record<string, unknown>)
      const normalizedMessage = {
        ...message,
        content: mergeReasoningIntoContent(message.content, reasoning)
      }
      const baseMessage = super._convertCompletionsMessageToBaseMessage(
        normalizedMessage,
        rawResponse
      )
      return this.exposeReasoning
        ? attachReasoningToAdditionalKwargs(baseMessage, reasoning)
        : baseMessage
    } catch (e) {
      console.warn(
        "[InterleavedThinking] _convertCompletionsMessageToBaseMessage failed, falling back to base:",
        e
      )
      return super._convertCompletionsMessageToBaseMessage(...args)
    }
  }

  override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]>
  ): ReturnType<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]> {
    try {
      const [delta, rawResponse, defaultRole] = args
      const reasoningText = extractReasoningFromRecord(delta as unknown as Record<string, unknown>)
      const contentText = typeof delta.content === "string" ? delta.content : ""
      const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
      const shouldCloseThink =
        this.thinkingOpen &&
        (!reasoningText || reasoningText.length === 0) &&
        (contentText.length > 0 || hasToolCalls || rawResponse.choices?.[0]?.finish_reason != null)

      let nextContent = contentText
      if (reasoningText) {
        let reasoningChunk = reasoningText
        if (this.thinkingOpen && startsWithThinkTag(reasoningChunk)) {
          reasoningChunk = reasoningChunk.replace(/^\s*<think>/, "")
        }
        if (
          !this.thinkingOpen &&
          !hasThinkOpenTag(reasoningChunk) &&
          !hasThinkCloseTag(reasoningChunk)
        ) {
          reasoningChunk = `${THINK_OPEN_TAG}${reasoningChunk}`
        }

        const thinkingOpenAfterReasoning = resolveThinkOpenState(this.thinkingOpen, reasoningChunk)
        nextContent = reasoningChunk

        if (
          thinkingOpenAfterReasoning &&
          (contentText.length > 0 ||
            hasToolCalls ||
            rawResponse.choices?.[0]?.finish_reason != null)
        ) {
          nextContent += `${THINK_CLOSE_TAG}${contentText.length > 0 ? `\n\n${contentText}` : ""}`
          this.thinkingOpen = false
        } else {
          if (contentText.length > 0) {
            nextContent += reasoningChunk.length > 0 ? `\n${contentText}` : contentText
          }
          this.thinkingOpen = thinkingOpenAfterReasoning
        }
      } else if (shouldCloseThink) {
        nextContent =
          nextContent.length > 0 ? `${THINK_CLOSE_TAG}\n\n${nextContent}` : THINK_CLOSE_TAG
        this.thinkingOpen = false
      }

      const chunk = super._convertCompletionsDeltaToBaseMessageChunk(
        {
          ...delta,
          content: nextContent
        },
        rawResponse,
        defaultRole ?? (reasoningText ? "assistant" : undefined)
      )
      return this.exposeReasoning ? attachReasoningToAdditionalKwargs(chunk, reasoningText) : chunk
    } catch (e) {
      console.warn(
        "[InterleavedThinking] _convertCompletionsDeltaToBaseMessageChunk failed, falling back to base:",
        e
      )
      this.thinkingOpen = false
      return super._convertCompletionsDeltaToBaseMessageChunk(...args)
    }
  }
}

export class ReasoningDisplayChatOpenAICompletions extends ChatOpenAICompletions {
  override _convertCompletionsMessageToBaseMessage(
    ...args: Parameters<ChatOpenAICompletions["_convertCompletionsMessageToBaseMessage"]>
  ): ReturnType<ChatOpenAICompletions["_convertCompletionsMessageToBaseMessage"]> {
    try {
      const [message, rawResponse] = args
      const baseMessage = super._convertCompletionsMessageToBaseMessage(message, rawResponse)
      return attachReasoningToAdditionalKwargs(
        baseMessage,
        extractReasoningFromRecord(message as unknown as Record<string, unknown>)
      )
    } catch (e) {
      console.warn(
        "[ReasoningDisplay] _convertCompletionsMessageToBaseMessage failed, falling back to base:",
        e
      )
      return super._convertCompletionsMessageToBaseMessage(...args)
    }
  }

  override _convertCompletionsDeltaToBaseMessageChunk(
    ...args: Parameters<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]>
  ): ReturnType<ChatOpenAICompletions["_convertCompletionsDeltaToBaseMessageChunk"]> {
    try {
      const [delta, rawResponse, defaultRole] = args
      const reasoning = extractReasoningFromRecord(delta as unknown as Record<string, unknown>)
      const chunk = super._convertCompletionsDeltaToBaseMessageChunk(
        delta,
        rawResponse,
        defaultRole ?? (reasoning ? "assistant" : undefined)
      )
      return attachReasoningToAdditionalKwargs(chunk, reasoning)
    } catch (e) {
      console.warn(
        "[ReasoningDisplay] _convertCompletionsDeltaToBaseMessageChunk failed, falling back to base:",
        e
      )
      return super._convertCompletionsDeltaToBaseMessageChunk(...args)
    }
  }
}
