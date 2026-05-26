type StableToolCall = {
  id?: string
  name?: string
  args?: unknown
}

type StableValuesMessageIdInput = {
  explicitId?: string
  index: number
  type: "ai" | "tool"
  className?: string
  content?: string
  toolCallId?: string
  name?: string
  toolCalls?: StableToolCall[]
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`
}

function hashString(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function buildStableValuesMessageId(input: StableValuesMessageIdInput): string {
  if (input.explicitId) return input.explicitId

  const toolCallIdentity =
    input.toolCalls
      ?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        argsDigest: toolCall.args === undefined ? undefined : hashString(stableJson(toolCall.args))
      }))
      .filter((toolCall) => toolCall.id || toolCall.name || toolCall.argsDigest) ?? []

  const identity = {
    index: input.index,
    type: input.type,
    className: input.className,
    toolCallId: input.toolCallId,
    name: input.name,
    // Do not include message content here. Values snapshots may report the
    // same logical message with more complete content later; the id must stay
    // stable so live merge updates that message instead of appending a copy.
    toolCalls: toolCallIdentity
  }

  return `values:${input.index}:${input.type}:${hashString(stableJson(identity))}`
}
