import {
  fingerprintSubagentTranscriptContent,
  isSubagentTranscriptBlobRef,
  projectSubagentDescription,
  projectSubagentTranscriptStartupContent,
  SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT,
  SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
} from "../../shared/subagent-transcript-storage"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function projectSubagentTranscriptStartupMessage(
  rawMessage: unknown,
  omitPreview = false
): unknown {
  if (!isRecord(rawMessage)) return rawMessage
  const message: UnknownRecord = {}
  for (const key of [
    "id",
    "role",
    "content",
    "provider_source_id",
    "provider_occurrence",
    "content_priority",
    "content_is_projection",
    "content_full_length",
    "content_ref",
    "reasoning",
    "reasoning_is_projection",
    "reasoning_full_length",
    "reasoning_ref",
    "tool_calls",
    "tool_calls_ref",
    "tool_call_id",
    "name",
    "status",
    "is_error",
    "replaces_message_id",
    "replaces_message_id_prefix",
    "replacement_mode",
    "replaced_message_ids",
    "replaced_message_id_prefixes",
    "compatible_replaced_message_id_prefixes",
    "subagent_tool_call_id",
    "subagent_invocation_scope",
    "subagent_prompt_fingerprint",
    "subagent_content_fingerprint",
    "subagent_reasoning_fingerprint",
    "subagent_startup_projection",
    "subagent_startup_tool_calls_projection",
    "subagent_name",
    "subagent_description",
    "subagent_type",
    "created_at",
    "start_at",
    "end_at"
  ]) {
    if (Object.prototype.hasOwnProperty.call(rawMessage, key)) message[key] = rawMessage[key]
  }
  for (const key of [
    "id",
    "role",
    "provider_source_id",
    "tool_call_id",
    "name",
    "status",
    "replaces_message_id",
    "replaces_message_id_prefix",
    "replacement_mode",
    "subagent_tool_call_id",
    "subagent_invocation_scope",
    "subagent_prompt_fingerprint",
    "subagent_content_fingerprint",
    "subagent_reasoning_fingerprint"
  ] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key])
    } else if (message[key] !== undefined) {
      delete message[key]
    }
  }
  for (const [key, kind] of [
    ["content_ref", "content"],
    ["reasoning_ref", "reasoning"],
    ["tool_calls_ref", "tool_calls"]
  ] as const) {
    if (message[key] !== undefined && !isSubagentTranscriptBlobRef(message[key], kind)) {
      delete message[key]
    }
  }
  for (const key of ["created_at", "start_at", "end_at"] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key])
    } else if (typeof message[key] !== "number") {
      delete message[key]
    }
  }
  for (const key of [
    "provider_occurrence",
    "content_priority",
    "content_full_length",
    "reasoning_full_length"
  ] as const) {
    if (
      message[key] !== undefined &&
      (typeof message[key] !== "number" || !Number.isSafeInteger(message[key]))
    ) {
      delete message[key]
    }
  }
  for (const key of [
    "content_is_projection",
    "reasoning_is_projection",
    "is_error",
    "subagent_startup_projection",
    "subagent_startup_tool_calls_projection"
  ] as const) {
    if (message[key] !== undefined && typeof message[key] !== "boolean") delete message[key]
  }

  const isPrompt =
    message.role === "user" &&
    ((typeof message.id === "string" && message.id.startsWith("subagent-prompt-")) ||
      typeof message.subagent_tool_call_id === "string")
  const isFinal =
    message.role === "assistant" &&
    ((typeof message.id === "string" && message.id.startsWith("subagent-final-")) ||
      (typeof message.content_priority === "number" && message.content_priority > 0))
  if (
    isPrompt &&
    typeof message.content === "string" &&
    message.content_is_projection !== true &&
    typeof message.subagent_prompt_fingerprint !== "string"
  ) {
    message.subagent_prompt_fingerprint = fingerprintSubagentTranscriptContent(message.content)
  }
  if (isFinal) {
    if (
      typeof message.content === "string" &&
      message.content_is_projection !== true &&
      typeof message.subagent_content_fingerprint !== "string"
    ) {
      message.subagent_content_fingerprint = fingerprintSubagentTranscriptContent(message.content)
    }
    if (
      typeof message.reasoning === "string" &&
      message.reasoning_is_projection !== true &&
      typeof message.subagent_reasoning_fingerprint !== "string"
    ) {
      message.subagent_reasoning_fingerprint = fingerprintSubagentTranscriptContent(
        message.reasoning
      )
    }
  }
  for (const key of ["subagent_name", "subagent_description", "subagent_type"] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key])
    }
  }
  for (const key of [
    "replaced_message_ids",
    "replaced_message_id_prefixes",
    "compatible_replaced_message_id_prefixes"
  ] as const) {
    if (Array.isArray(message[key])) {
      message[key] = message[key]
        .filter((value): value is string => typeof value === "string")
        .slice(-8)
        .map((value) => projectSubagentDescription(value))
    }
  }

  let hasStartupProjection =
    message.subagent_startup_projection === true ||
    message.content_is_projection === true ||
    message.reasoning_is_projection === true ||
    isSubagentTranscriptBlobRef(message.content_ref, "content") ||
    isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning") ||
    isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")
  if (isSubagentTranscriptBlobRef(message.content_ref, "content")) {
    message.content_is_projection = true
  }
  if (isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning")) {
    message.reasoning_is_projection = true
  }
  if (typeof message.content === "string") {
    const projected = omitPreview
      ? ""
      : projectSubagentTranscriptStartupContent(message.content)
    if (projected !== message.content) {
      message.content_full_length =
        typeof message.content_full_length === "number"
          ? message.content_full_length
          : message.content.length
      message.content = projected
      message.content_is_projection = true
      hasStartupProjection = true
    }
  } else if (message.content !== undefined) {
    message.content = []
    message.content_is_projection = true
    hasStartupProjection = true
  }
  if (typeof message.reasoning === "string") {
    const projected = omitPreview
      ? ""
      : projectSubagentTranscriptStartupContent(message.reasoning)
    if (projected !== message.reasoning) {
      message.reasoning_full_length =
        typeof message.reasoning_full_length === "number"
          ? message.reasoning_full_length
          : message.reasoning.length
      message.reasoning = projected
      message.reasoning_is_projection = true
      hasStartupProjection = true
    }
  } else if (message.reasoning !== undefined) {
    delete message.reasoning
    message.reasoning_is_projection = true
    hasStartupProjection = true
  }
  if (message.tool_calls !== undefined) {
    delete message.tool_calls
    message.subagent_startup_tool_calls_projection = true
    hasStartupProjection = true
  }
  if (isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")) {
    message.subagent_startup_tool_calls_projection = true
    hasStartupProjection = true
  }
  if (hasStartupProjection) message.subagent_startup_projection = true
  return message
}

function startupBucket(
  rawMessages: unknown,
  subagentId: string,
  omitPreview = false
): unknown[] {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return []
  const promptIndex = rawMessages.findIndex(
    (message) =>
      isRecord(message) &&
      message.role === "user" &&
      (message.id === `subagent-prompt-${subagentId}` ||
        typeof message.subagent_tool_call_id === "string")
  )
  let finalIndex = -1
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index]
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      (message.id === `subagent-final-${subagentId}` ||
        (typeof message.content_priority === "number" &&
          message.content_priority >= 1 &&
          (message.status !== undefined || message.is_error === true)))
    ) {
      finalIndex = index
      break
    }
  }
  const selectedIndexes = new Set<number>()
  if (promptIndex >= 0) selectedIndexes.add(promptIndex)
  if (finalIndex >= 0) selectedIndexes.add(finalIndex)
  if (selectedIndexes.size === 0) {
    selectedIndexes.add(0)
    selectedIndexes.add(rawMessages.length - 1)
  }
  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => projectSubagentTranscriptStartupMessage(rawMessages[index], omitPreview))
}

function entryAdditionalBytes(
  subagentId: string,
  messages: readonly unknown[],
  hasExistingEntry: boolean
): number {
  const entryObjectBytes = Buffer.byteLength(
    JSON.stringify({ [subagentId]: messages }),
    "utf8"
  )
  return entryObjectBytes - 2 + (hasExistingEntry ? 1 : 0)
}

/** Build the startup cards with a hard byte ceiling; oversized old buckets stay pageable. */
export function buildSubagentTranscriptStartupProjection(
  transcripts: unknown,
  byteLimit: number = SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
): Record<string, unknown> {
  if (!isRecord(transcripts)) return {}
  const hardLimit = Number.isFinite(byteLimit)
    ? Math.max(2, Math.floor(byteLimit))
    : SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
  const candidates = Object.entries(transcripts)
    .slice(0, SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT)
    .map(([subagentId, rawMessages], index) => {
      const messages = startupBucket(rawMessages, subagentId)
      const hasFinal = messages.some(
        (message) => isRecord(message) && message.id === `subagent-final-${subagentId}`
      )
      return { subagentId, rawMessages, messages, hasFinal, index }
    })
  candidates.sort((left, right) => {
    if (left.hasFinal !== right.hasFinal) return left.hasFinal ? 1 : -1
    return right.index - left.index
  })

  const accepted = new Map<string, unknown[]>()
  let usedBytes = 2
  for (const candidate of candidates) {
    let messages = candidate.messages
    let additionalBytes = entryAdditionalBytes(
      candidate.subagentId,
      messages,
      accepted.size > 0
    )
    if (usedBytes + additionalBytes > hardLimit) {
      messages = startupBucket(candidate.rawMessages, candidate.subagentId, true)
      additionalBytes = entryAdditionalBytes(
        candidate.subagentId,
        messages,
        accepted.size > 0
      )
    }
    if (usedBytes + additionalBytes > hardLimit) continue
    accepted.set(candidate.subagentId, messages)
    usedBytes += additionalBytes
  }
  const result = Object.fromEntries(
    candidates.flatMap(({ subagentId }) => {
      const messages = accepted.get(subagentId)
      return messages ? [[subagentId, messages] as const] : []
    })
  )
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > hardLimit) {
    throw new Error("Subagent startup projection exceeded its hard response ceiling")
  }
  return result
}
