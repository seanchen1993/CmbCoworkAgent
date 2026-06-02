type StableToolCall = {
  id?: string
  name?: string
  args?: unknown
}

type StableValuesMessageIdInput = {
  explicitId?: string
  index: number
  type: "ai" | "tool" | "system" | "human"
  className?: string
  content?: string
  toolCallId?: string
  name?: string
  toolCalls?: StableToolCall[]
}

type CurrentTurnMessageFallbackIdInput = {
  type: "ai" | "tool"
  content?: string
  toolCallId?: string
  toolName?: string
  toolCalls?: StableToolCall[]
}

type SyntheticCheckpointBaselineIdsInput = StableValuesMessageIdInput

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`
}

function hashString(input: string, radix: 16 | 36 = 16): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const result = (hash >>> 0).toString(radix)
  return radix === 16 ? result.padStart(8, "0") : result
}

function normalizeMessageClassName(className?: string): string | undefined {
  return className?.replace(/Chunk$/, "")
}

export function buildToolMessageFallbackId(toolCallId: string, toolName?: string): string {
  return `tool-${toolCallId}-${toolName || "result"}`
}

export function buildCurrentTurnMessageFallbackId(
  input: CurrentTurnMessageFallbackIdInput
): string {
  if (input.type === "tool" && input.toolCallId) {
    return buildToolMessageFallbackId(input.toolCallId, input.toolName)
  }

  const toolCallKey = input.toolCalls
    ?.map((toolCall, index) => {
      const args = toolCall.args ? stableJson(toolCall.args) : ""
      return `${toolCall.id || index}:${toolCall.name || "tool"}:${args}`
    })
    .join("|")

  const source = [
    input.type,
    input.toolCallId || "",
    input.toolName || "",
    toolCallKey || "",
    input.content || ""
  ].join("\u001f")

  return `${input.type}-${hashString(source, 36)}`
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
    className: normalizeMessageClassName(input.className),
    toolCallId: input.toolCallId,
    name: input.name,
    // Do not include message content here. Values snapshots may report the
    // same logical message with more complete content later; the id must stay
    // stable so live merge updates that message instead of appending a copy.
    // AIMessage chunks may stream before the final `tool_calls` shape is
    // available, while values snapshots include the completed message. Keep
    // assistant fallback ids tied to the message slot, not the late-arriving
    // tool call payload, so messages and values paths agree.
    toolCalls: input.type === "ai" ? undefined : toolCallIdentity
  }

  return `values:${input.index}:${input.type}:${hashString(stableJson(identity))}`
}

export function buildSyntheticCheckpointBaselineIds(
  input: SyntheticCheckpointBaselineIdsInput
): string[] {
  const ids = [
    buildStableValuesMessageId({
      explicitId: input.explicitId,
      index: input.index,
      type: input.type,
      className: input.className,
      content: input.content,
      toolCallId: input.toolCallId,
      name: input.name,
      toolCalls: input.toolCalls
    })
  ]

  // Coordinator values snapshots can synthesize current-turn messages with
  // ai-* / tool-* ids instead of values:* ids. Seed both identities for
  // synthetic checkpoint messages so restore does not append a duplicate.
  if (input.type === "ai" || input.type === "tool") {
    ids.push(
      buildCurrentTurnMessageFallbackId({
        type: input.type,
        content: input.content,
        toolCallId: input.toolCallId,
        toolName: input.name,
        toolCalls: input.toolCalls
      })
    )
  }

  return ids
}
