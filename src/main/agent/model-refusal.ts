export interface ModelRefusal {
  category: string | null
  explanation: string | null
}

export class ModelRefusalError extends Error {
  constructor() {
    super("模型提供商拒绝了本次请求，本回合按未完成处理。")
    this.name = "ModelRefusalError"
  }
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Explicit provider protocol only. Ordinary answer prose never classifies a refusal. */
export function readModelRefusal(value: unknown): ModelRefusal | undefined {
  const message = object(value)
  if (!message) return undefined
  const metadata = object(message.response_metadata)
  const additional = object(message.additional_kwargs)
  for (const source of [metadata, additional]) {
    if (source?.stop_reason === "refusal" || source?.finish_reason === "refusal") {
      const details = object(source.stop_details)
      return {
        category: typeof details?.category === "string" ? details.category : null,
        explanation: typeof details?.explanation === "string" ? details.explanation : null
      }
    }
  }
  const refusal = additional?.refusal
  if (typeof refusal === "string" && refusal.length) return { category: null, explanation: refusal }
  if (Array.isArray(message.content)) {
    const blocks = message.content.map(object)
    const text = blocks
      .filter((block) => block?.type === "refusal" && typeof block.refusal === "string")
      .map((block) => block!.refusal)
      .join("")
    if (text) return { category: null, explanation: text }
  }
  // OpenAI-compatible content filters report a terminal reason, without Anthropic categories.
  if ([metadata, additional].some((source) => source?.finish_reason === "content_filter"))
    return { category: null, explanation: null }
  return undefined
}
