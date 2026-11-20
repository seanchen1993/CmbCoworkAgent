import { BaseMessage, isAIMessage } from "@langchain/core/messages"
import type { FunctionTurnUsage } from "../../../shared/mods/v2/turn"
import { normalizeTraceTokenUsage } from "../../agent/trace/token-usage"
import { MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY } from "../../../shared/message-role-collision"
import { MODS_MAX_BYTES } from "../../../shared/mods/validation"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Consume complete, actual model responses; do not count history, streaming fragments or UI notices. */
export class FunctionTurnObservation {
  private readonly seen = new Set<string>()
  private readonly seenObjects = new WeakSet<object>()
  private count = 0
  private total?: FunctionTurnUsage
  private incompleteUsage = false
  private response?: { content: unknown }
  private partial?: { id: string; text: string }
  private overflow = false

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
    if (previous.length + text.length > MODS_MAX_BYTES) {
      this.partial = { id, text: "" }
      this.overflow = true
      return
    }
    this.partial = { id, text: previous + text }
  }

  observe(value: unknown): void {
    if (!BaseMessage.isInstance(value) || !isAIMessage(value)) return
    this.response = value
    this.partial = undefined
    this.overflow = false
    if (value.id ? this.seen.has(value.id) : this.seenObjects.has(value)) return
    if (this.count >= 10000) {
      this.incompleteUsage = true
      return
    }
    if (value.id) this.seen.add(value.id)
    else this.seenObjects.add(value)
    this.count++
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
    ) {
      this.incompleteUsage = true
      return
    }
    const read = usage.cacheReadTokens ?? 0
    const created = usage.cacheCreationTokens ?? 0
    const input = usage.inputTokens - (normalized ? read + created : 0)
    const values = [input, usage.outputTokens, read, created]
    if (values.some((count) => !Number.isSafeInteger(count) || count < 0)) {
      this.incompleteUsage = true
      return
    }
    const next: FunctionTurnUsage = {
      model,
      input_tokens: (this.total?.input_tokens ?? 0) + input,
      output_tokens: (this.total?.output_tokens ?? 0) + usage.outputTokens,
      cache_read_input_tokens: (this.total?.cache_read_input_tokens ?? 0) + read,
      cache_creation_input_tokens: (this.total?.cache_creation_input_tokens ?? 0) + created
    }
    if (
      Object.values(next).some((count) => typeof count === "number" && !Number.isSafeInteger(count))
    )
      this.incompleteUsage = true
    this.total = next
  }

  snapshot(): { answer: string; usage?: FunctionTurnUsage } {
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
    return {
      answer: this.partial?.text ?? answer,
      ...(!this.incompleteUsage && this.total ? { usage: { ...this.total } } : {})
    }
  }
}
