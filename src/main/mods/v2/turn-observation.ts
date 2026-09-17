import { BaseMessage, isAIMessage } from "@langchain/core/messages"
import type { FunctionTurnUsage } from "../../../shared/mods/v2/turn"
import { normalizeTraceTokenUsage } from "../../agent/trace/token-usage"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY } from "../../../shared/message-role-collision"
import { MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { readModelRefusal, type ModelRefusal } from "../../agent/model-refusal"

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Consume complete, actual model responses; do not count history, streaming fragments or UI notices. */
export class FunctionTurnObservation {
  private readonly seen = new Map<string, number>()
  private readonly seenObjects = new WeakMap<object, number>()
  private readonly usage = new Map<number, FunctionTurnUsage>()
  private count = 0
  private usageOverflow = false
  private response?: { content: unknown; id?: string }
  private partial?: { id: string; text: string; messageId?: string }
  private overflow = false
  private refusal?: ModelRefusal

  observeStream(payload: unknown, mode: "delta" | "snapshot"): void {
    if (!Array.isArray(payload)) return
    const envelope = object(payload[0])
    const message = object(envelope?.kwargs) ?? envelope
    if (!message) return
    const className = Array.isArray(envelope?.id) ? String(envelope.id.at(-1)) : ""
    if (!className.includes("AI") && message.type !== "ai" && message.type !== "assistant") return
    const id =
      object(message.additional_kwargs)?.[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY] ?? message.id
    if (typeof id !== "string" || this.seen.has(id)) return
    if (this.partial?.id !== id || mode === "snapshot") this.overflow = false
    if (this.overflow) return
    const content = message.content
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) => object(block))
              .filter((block) => block?.type === "text" && typeof block.text === "string")
              .map((block) => block!.text)
              .join("")
          : ""
    const previous = mode === "delta" && this.partial?.id === id ? this.partial.text : ""
    const messageId =
      typeof message.id === "string"
        ? message.id
        : this.partial?.id === id
          ? this.partial.messageId
          : undefined
    if (previous.length + text.length > MODS_MAX_BYTES) {
      this.partial = { id, text: "", messageId }
      this.overflow = true
      return
    }
    this.partial = { id, text: previous + text, messageId }
  }

  /** Presentation identity stays outside the plugin's public event and result. */
  get anchorMessageId(): string | undefined {
    return this.partial ? this.partial.messageId : this.response?.id
  }

  observe(value: unknown): void {
    if (!BaseMessage.isInstance(value) || !isAIMessage(value)) return
    this.refusal = readModelRefusal(value) ?? this.refusal
    this.response = value
    this.partial = undefined
    this.overflow = false
    let key = value.id ? this.seen.get(value.id) : this.seenObjects.get(value)
    if (key === undefined) {
      if (this.count >= 10000) {
        this.usageOverflow = true
        return
      }
      key = this.count++
      if (value.id) this.seen.set(value.id, key)
      else this.seenObjects.set(value, key)
    }
    const metadata = object(value.response_metadata)
    const model = metadata?.model_name ?? metadata?.model
    const normalized = !!value.usage_metadata
    const rawUsage = value.usage_metadata ?? metadata?.usage
    const usage = normalizeTraceTokenUsage(rawUsage)
    if (
      typeof model !== "string" ||
      !model ||
      !usage ||
      usage.inputTokens === undefined ||
      usage.outputTokens === undefined
    )
      return
    const read = usage.cacheReadTokens ?? 0
    const created = usage.cacheCreationTokens ?? 0
    const input = usage.inputTokens - (normalized ? read + created : 0)
    const values = [input, usage.outputTokens, read, created]
    if (values.some((count) => !Number.isSafeInteger(count) || count < 0)) return
    // Frozen fzn/gUe/Ryt replaces valid usage for an existing response identity.
    // Missing usage contributes nothing and does not erase an earlier valid observation.
    this.usage.set(key, {
      model,
      input_tokens: input,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: created
    })
  }

  snapshot(): { answer: string; usage?: FunctionTurnUsage; refusal?: ModelRefusal } {
    if (this.overflow) throw new ModFunctionError("MODS_JSON_SIZE")
    const content = this.response?.content
    const answer =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .map((block) => object(block))
              .filter((block) => block?.type === "text" && typeof block.text === "string")
              .map((block) => block!.text)
              .join("")
          : ""
    let total: FunctionTurnUsage | undefined
    if (!this.usageOverflow) {
      for (const value of this.usage.values()) {
        total = {
          model: value.model,
          input_tokens: (total?.input_tokens ?? 0) + value.input_tokens,
          output_tokens: (total?.output_tokens ?? 0) + value.output_tokens,
          cache_read_input_tokens:
            (total?.cache_read_input_tokens ?? 0) + value.cache_read_input_tokens,
          cache_creation_input_tokens:
            (total?.cache_creation_input_tokens ?? 0) + value.cache_creation_input_tokens
        }
        if (
          Object.values(total).some(
            (value) => typeof value === "number" && !Number.isSafeInteger(value)
          )
        ) {
          total = undefined
          break
        }
      }
    }
    return {
      answer: this.partial?.text ?? answer,
      ...(total ? { usage: total } : {}),
      ...(this.refusal ? { refusal: { ...this.refusal } } : {})
    }
  }
}
