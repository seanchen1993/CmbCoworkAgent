export interface CheckpointTranscriptIndex {
  visibleMessageIds: string[]
  internalGoalMessageIds: string[]
  subagentTranscriptIds: string[]
  visibleMessages: CheckpointTranscriptMessage[]
}

export interface CheckpointTranscriptMessage {
  id: string
  role: string
  text: string
}

export type CheckpointMessageForkTargetReason =
  | "missing_message"
  | "not_assistant"
  | "not_visible_boundary"
  | "not_checkpoint_tail"

export interface CheckpointMessageForkTargetStatus {
  isForkableMessageBoundary: boolean
  reason?: CheckpointMessageForkTargetReason
  message?: CheckpointTranscriptMessage
  transcript: CheckpointTranscriptIndex
}

export interface FilteredThreadValuesInput {
  messageTimes?: unknown
  messageTimeOrder?: unknown
  internalGoalMessageTimes?: unknown
  internalGoalMessageTimeOrder?: unknown
}

export interface CheckpointAuthorityTranscriptMessage {
  id: string
  role?: string
  content?: unknown
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
  status?: string
  is_error?: boolean
  goal_id?: string | null
  active_window_id?: string | null
  created_at?: unknown
  start_at?: unknown
  end_at?: unknown
}

export const WORKFLOW_NOTIFICATION_MARKER_PREFIX = "[[CMB_WORKFLOW_NOTIFICATION_V1:"
/** Renderer-submitted trigger; the main process expands it into the real notification. */
export const WORKFLOW_NOTIFICATION_TURN_TRIGGER = "[[CMB_WORKFLOW_NOTIFICATION_TURN]]"
/**
 * The exact internal notification prompt. It must stay byte-identical to the
 * renderer's WORKFLOW_NOTIFICATION_TURN_PROMPT; workflow-engine tests pin that
 * equality because silent drift breaks workflow completion delivery.
 */
export const WORKFLOW_NOTIFICATION_TURN_PROMPT = `${WORKFLOW_NOTIFICATION_TURN_TRIGGER}
Process the completed workflow task-notification. This is an internal system turn, not a new user request.`
const MESSAGE_TIMES_KEY = "messageTimes"
const MESSAGE_TIME_ORDER_KEY = "messageTimeOrder"
const INTERNAL_GOAL_MESSAGE_TIMES_KEY = "internalGoalMessageTimes"
const INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY = "internalGoalMessageTimeOrder"
const SUBAGENT_TRANSCRIPTS_KEY = "subagentTranscripts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function getMessageRole(message: Record<string, unknown>): string {
  const getter = message._getType
  if (typeof getter === "function") {
    try {
      const type = getter.call(message)
      if (type === "human") return "user"
      if (type === "ai") return "assistant"
      if (type === "system") return "system"
      if (type === "tool") return "tool"
    } catch {
      // Fall through to serialized fields.
    }
  }

  const id = message.id
  if (Array.isArray(id)) {
    const constructorName = id[id.length - 1]
    if (constructorName === "HumanMessage") return "user"
    if (constructorName === "AIMessage" || constructorName === "AIMessageChunk") {
      return "assistant"
    }
    if (constructorName === "SystemMessage") return "system"
    if (constructorName === "ToolMessage") return "tool"
  }

  const type =
    readString(message.type) ??
    (isRecord(message.kwargs) ? readString(message.kwargs.type) : undefined)
  if (type === "human") return "user"
  if (type === "ai") return "assistant"
  if (type === "system") return "system"
  if (type === "tool") return "tool"
  if (type === "user" || type === "assistant" || type === "system" || type === "tool") {
    return type
  }
  return "assistant"
}

function getMessageId(message: Record<string, unknown>, index: number): string {
  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  return readString(kwargs?.id) ?? readString(message.id) ?? `msg-${index}`
}

function getMessageContent(message: Record<string, unknown>): unknown {
  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  return message.content ?? kwargs?.content
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block
        if (!isRecord(block)) return ""
        const text = block.text ?? block.content
        return typeof text === "string" ? text : ""
      })
      .filter(Boolean)
      .join("\n")
  }
  if (isRecord(content)) {
    const text = content.text ?? content.content
    return typeof text === "string" ? text : ""
  }
  return ""
}

function hasUsefulMergeContent(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0
  if (Array.isArray(content)) return content.length > 0
  return false
}

function shouldUseIncomingContent(baseContent: unknown, incomingContent: unknown): boolean {
  if (!hasUsefulMergeContent(incomingContent)) return false
  if (!hasUsefulMergeContent(baseContent)) return true

  const baseText = stringifyContent(baseContent)
  const incomingText = stringifyContent(incomingContent)
  if (!baseText) return incomingText.length > 0
  if (!incomingText) return false
  return incomingText.length > baseText.length && incomingText.startsWith(baseText)
}

function mergeCheckpointAuthorityContent(baseContent: unknown, incomingContent: unknown): unknown {
  return shouldUseIncomingContent(baseContent, incomingContent) ? incomingContent : baseContent
}

export function isCheckpointEmptyAssistantToolCallMessage(
  message: CheckpointAuthorityTranscriptMessage
): boolean {
  const contentIsEmpty =
    message.content === undefined ||
    message.content === null ||
    message.content === "" ||
    (Array.isArray(message.content) && message.content.length === 0)
  return (
    message.role === "assistant" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0 &&
    contentIsEmpty
  )
}

function mergeCheckpointAuthorityToolCalls(
  baseToolCalls: unknown[] | undefined,
  incomingToolCalls: unknown[] | undefined
): unknown[] | undefined {
  if (Array.isArray(baseToolCalls) && baseToolCalls.length > 0) return baseToolCalls
  return Array.isArray(incomingToolCalls) && incomingToolCalls.length > 0
    ? incomingToolCalls
    : baseToolCalls
}

export function mergeCheckpointAuthorityTranscriptMessage<
  T extends CheckpointAuthorityTranscriptMessage
>(base: T, incoming: T): T {
  const checkpointClearsToolCallContent = isCheckpointEmptyAssistantToolCallMessage(base)
  return {
    ...base,
    content: checkpointClearsToolCallContent
      ? base.content
      : mergeCheckpointAuthorityContent(base.content, incoming.content),
    tool_calls: mergeCheckpointAuthorityToolCalls(base.tool_calls, incoming.tool_calls) as
      | T["tool_calls"]
      | undefined,
    tool_call_id: base.tool_call_id ?? incoming.tool_call_id,
    name: base.name ?? incoming.name,
    status: base.status ?? incoming.status,
    is_error: base.is_error ?? incoming.is_error,
    goal_id: incoming.goal_id ?? base.goal_id,
    active_window_id: incoming.active_window_id ?? base.active_window_id,
    created_at: incoming.created_at ?? base.created_at,
    start_at: incoming.start_at ?? base.start_at,
    end_at: incoming.end_at ?? base.end_at
  } as T
}

function transcriptMessageTimestamp(message: CheckpointAuthorityTranscriptMessage): number {
  const candidate = message.start_at ?? message.created_at ?? message.end_at
  const time =
    candidate instanceof Date
      ? candidate.getTime()
      : typeof candidate === "number" || typeof candidate === "string"
        ? new Date(candidate).getTime()
        : Number.MAX_SAFE_INTEGER
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER
}

export function mergeCheckpointAuthorityTranscriptMessages<
  T extends CheckpointAuthorityTranscriptMessage
>(
  baseMessages: readonly T[],
  incomingMessages: readonly T[],
  options: { isSameMessage?: (left: T, right: T) => boolean } = {}
): T[] {
  if (incomingMessages.length === 0) return [...baseMessages]
  const merged = [...baseMessages]
  const indexById = new Map(merged.map((message, index) => [message.id, index]))

  for (const incoming of [...incomingMessages].sort((left, right) => {
    const delta = transcriptMessageTimestamp(left) - transcriptMessageTimestamp(right)
    return delta || left.id.localeCompare(right.id)
  })) {
    const existingIndex = indexById.get(incoming.id)
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeCheckpointAuthorityTranscriptMessage(
        merged[existingIndex],
        incoming
      )
      continue
    }
    if (
      options.isSameMessage &&
      merged.some((message) => options.isSameMessage?.(message, incoming))
    ) {
      continue
    }
    merged.push(incoming)
    indexById.set(incoming.id, merged.length - 1)
  }

  return merged
}

function getAdditionalKwargs(
  message: Record<string, unknown>
): Record<string, unknown> | undefined {
  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  const additional = message.additional_kwargs ?? kwargs?.additional_kwargs
  return isRecord(additional) ? additional : undefined
}

function collectToolCallIds(value: unknown, ids: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const toolCall of value) {
    if (!isRecord(toolCall)) continue
    const id = readString(toolCall.id)
    if (id) ids.add(id)
  }
}

function getReferencedToolCallIds(message: Record<string, unknown>): string[] {
  const ids = new Set<string>()
  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  const additionalKwargs = getAdditionalKwargs(message)

  collectToolCallIds(message.tool_calls, ids)
  collectToolCallIds(kwargs?.tool_calls, ids)
  collectToolCallIds(additionalKwargs?.tool_calls, ids)

  const directToolCallId = readString(message.tool_call_id) ?? readString(kwargs?.tool_call_id)
  if (directToolCallId) ids.add(directToolCallId)

  return [...ids]
}

function isInternalGoalPrompt(role: string, content: unknown): boolean {
  if (role !== "user" || typeof content !== "string") return false
  const text = content.trimStart()
  const hasMarker =
    text.startsWith("[Starting active goal]") || text.startsWith("[Continuing active goal]")
  if (!hasMarker) return false
  return (
    text.includes("<untrusted_objective>") ||
    text.includes("<untrusted_completion_condition>") ||
    text.includes("<completion_condition>")
  )
}

function isGoalTranscriptArtifact(role: string, content: unknown): boolean {
  if (role !== "system" || typeof content !== "string") return false
  const text = content.trim()
  return (
    text.startsWith("Goal ") ||
    text.startsWith("✓ Goal") ||
    text.startsWith("● Goal") ||
    text.startsWith("Ⅱ Goal") ||
    text.startsWith("当前没有 active goal") ||
    text.startsWith("你发送了新消息，active goal 已暂停") ||
    text.startsWith("没有可继续的 goal") ||
    text.startsWith("附件和显式技能不会用于 /goal 控制命令")
  )
}

export function isWorkflowPlumbingTranscriptContent(content: unknown): boolean {
  if (typeof content !== "string") return false
  const text = content.trimStart()
  return (
    text === WORKFLOW_NOTIFICATION_TURN_PROMPT ||
    text.startsWith(WORKFLOW_NOTIFICATION_MARKER_PREFIX)
  )
}

function isVisibleTranscriptMessage(role: string, content: unknown): boolean {
  return (
    !isInternalGoalPrompt(role, content) &&
    !isGoalTranscriptArtifact(role, content) &&
    !isWorkflowPlumbingTranscriptContent(content)
  )
}

function getCheckpointMessages(checkpoint: unknown): unknown[] {
  if (!isRecord(checkpoint)) return []
  const channelValues = isRecord(checkpoint.channel_values) ? checkpoint.channel_values : undefined
  return Array.isArray(channelValues?.messages) ? channelValues.messages : []
}

export function truncateCheckpointMessagesAfter(checkpoint: unknown, messageId: string): boolean {
  const targetMessageId = messageId.trim()
  if (!targetMessageId || !isRecord(checkpoint)) return false

  const channelValues = isRecord(checkpoint.channel_values) ? checkpoint.channel_values : undefined
  if (!channelValues) return false

  const messages = Array.isArray(channelValues.messages) ? channelValues.messages : undefined
  if (!messages) return false

  const targetIndex = messages.findIndex((raw, index) => {
    return isRecord(raw) && getMessageId(raw, index) === targetMessageId
  })
  if (targetIndex < 0) return false

  channelValues.messages = messages.slice(0, targetIndex + 1)
  return true
}

export function checkpointHasInterrupt(checkpoint: unknown): boolean {
  if (!isRecord(checkpoint)) return false
  const channelValues = isRecord(checkpoint.channel_values) ? checkpoint.channel_values : undefined
  const interrupts = channelValues?.__interrupt__
  return Array.isArray(interrupts) && interrupts.length > 0
}

export function deriveCheckpointTranscriptIndex(checkpoint: unknown): CheckpointTranscriptIndex {
  const visibleMessageIds: string[] = []
  const internalGoalMessageIds: string[] = []
  const subagentTranscriptIds: string[] = []
  const seenSubagentTranscriptIds = new Set<string>()
  const visibleMessages: CheckpointTranscriptMessage[] = []

  getCheckpointMessages(checkpoint).forEach((raw, index) => {
    if (!isRecord(raw)) return
    const additionalKwargs = getAdditionalKwargs(raw)
    if (additionalKwargs?.cmb_internal_coordinator_notification === true) return

    for (const toolCallId of getReferencedToolCallIds(raw)) {
      if (seenSubagentTranscriptIds.has(toolCallId)) continue
      seenSubagentTranscriptIds.add(toolCallId)
      subagentTranscriptIds.push(toolCallId)
    }

    const role = getMessageRole(raw)
    const checkpointContent = getMessageContent(raw)
    const messageId = getMessageId(raw, index)
    const rawInternalGoalPrompt = isInternalGoalPrompt(role, checkpointContent)
    if (rawInternalGoalPrompt) {
      internalGoalMessageIds.push(messageId)
    }

    const visibleUserMessage = additionalKwargs?.cmb_visible_user_message
    const effectiveContent =
      role === "user" && typeof visibleUserMessage === "string" && visibleUserMessage.length > 0
        ? visibleUserMessage
        : checkpointContent

    if (isVisibleTranscriptMessage(role, effectiveContent)) {
      visibleMessageIds.push(messageId)
      visibleMessages.push({
        id: messageId,
        role,
        text: stringifyContent(effectiveContent)
      })
    }
  })

  return { visibleMessageIds, internalGoalMessageIds, subagentTranscriptIds, visibleMessages }
}

export function describeCheckpointMessageForkTarget(
  checkpoint: unknown,
  messageId: string
): CheckpointMessageForkTargetStatus {
  const targetMessageId = messageId.trim()
  const transcript = deriveCheckpointTranscriptIndex(checkpoint)
  const missing = (
    reason: CheckpointMessageForkTargetReason
  ): CheckpointMessageForkTargetStatus => ({
    isForkableMessageBoundary: false,
    reason,
    transcript
  })
  if (!targetMessageId) return missing("missing_message")

  const target = transcript.visibleMessages.find((message) => message.id === targetMessageId)
  if (!target) return missing("missing_message")
  if (target.role !== "assistant") {
    return {
      isForkableMessageBoundary: false,
      reason: "not_assistant",
      message: target,
      transcript
    }
  }
  if (transcript.visibleMessageIds.at(-1) !== targetMessageId) {
    return {
      isForkableMessageBoundary: false,
      reason: "not_visible_boundary",
      message: target,
      transcript
    }
  }

  const rawMessages = getCheckpointMessages(checkpoint)
  const targetRawIndex = rawMessages.findIndex((raw, index) => {
    return isRecord(raw) && getMessageId(raw, index) === targetMessageId
  })
  const hasRawMessagesAfterTarget = targetRawIndex < 0 || targetRawIndex < rawMessages.length - 1
  if (hasRawMessagesAfterTarget) {
    return {
      isForkableMessageBoundary: false,
      reason: "not_checkpoint_tail",
      message: target,
      transcript
    }
  }

  return {
    isForkableMessageBoundary: true,
    message: target,
    transcript
  }
}

export function filterMessagesToCheckpointVisibleIds<T extends { id?: string }>(
  messages: readonly T[],
  transcriptIndex: Pick<CheckpointTranscriptIndex, "visibleMessageIds"> | null | undefined
): T[] {
  if (!transcriptIndex) return [...messages]
  const allowedIds = new Set(transcriptIndex.visibleMessageIds)
  if (allowedIds.size === 0) return []
  return messages.filter((message) => typeof message.id === "string" && allowedIds.has(message.id))
}

export function findMessagesAfterCheckpointVisibleIds<T extends { id?: string }>(
  messages: readonly T[],
  checkpointVisibleMessageIds: readonly string[],
  options: { excludeMessageIds?: readonly string[] } = {}
): T[] {
  if (checkpointVisibleMessageIds.length === 0) return []
  const checkpointIds = new Set(checkpointVisibleMessageIds)
  const excluded = new Set(options.excludeMessageIds ?? [])
  let lastCheckpointMessageIndex = -1

  messages.forEach((message, index) => {
    if (typeof message.id === "string" && checkpointIds.has(message.id)) {
      lastCheckpointMessageIndex = index
    }
  })

  return messages.filter((message, index) => {
    if (typeof message.id !== "string") return false
    if (excluded.has(message.id)) return false
    if (checkpointIds.has(message.id)) return false
    return lastCheckpointMessageIndex < 0 || index > lastCheckpointMessageIndex
  })
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function filterTimeMap(
  value: unknown,
  ids: readonly string[]
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const next: Record<string, unknown> = {}
  for (const id of ids) {
    const entry = value[id]
    if (isRecord(entry)) next[id] = cloneJsonObject(entry)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function orderEntryMap(value: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  if (!Array.isArray(value)) return map
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue
    map.set(entry.id, entry)
  }
  return map
}

function buildOrder(
  ids: readonly string[],
  timeMap: unknown,
  order: unknown
): Array<Record<string, unknown> & { id: string }> | undefined {
  const byId = orderEntryMap(order)
  const sourceTimeMap = isRecord(timeMap) ? timeMap : {}
  const next = ids.map((id) => {
    const mapped = isRecord(sourceTimeMap[id]) ? sourceTimeMap[id] : undefined
    const ordered = byId.get(id)
    const entry = mapped ?? ordered
    return entry
      ? ({ id, ...cloneJsonObject(entry) } as Record<string, unknown> & { id: string })
      : { id }
  })
  return next.length > 0 ? next : undefined
}

function filterSubagentTranscripts(
  value: unknown,
  ids: readonly string[]
): Record<string, unknown> | undefined {
  if (!isRecord(value) || ids.length === 0) return undefined
  const next: Record<string, unknown> = {}
  for (const id of ids) {
    const transcript = value[id]
    if (Array.isArray(transcript)) next[id] = cloneJsonValue(transcript)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function buildFilteredThreadValues(
  sourceThreadValues: Record<string, unknown> | null | undefined,
  transcriptIndex: CheckpointTranscriptIndex
): Record<string, unknown> {
  if (!isRecord(sourceThreadValues)) return {}

  const next: Record<string, unknown> = {}
  const messageTimes = filterTimeMap(
    sourceThreadValues[MESSAGE_TIMES_KEY],
    transcriptIndex.visibleMessageIds
  )
  const internalGoalMessageTimes = filterTimeMap(
    sourceThreadValues[INTERNAL_GOAL_MESSAGE_TIMES_KEY],
    transcriptIndex.internalGoalMessageIds
  )
  const messageTimeOrder = buildOrder(
    transcriptIndex.visibleMessageIds,
    sourceThreadValues[MESSAGE_TIMES_KEY],
    sourceThreadValues[MESSAGE_TIME_ORDER_KEY]
  )
  const internalGoalMessageTimeOrder = buildOrder(
    transcriptIndex.internalGoalMessageIds,
    sourceThreadValues[INTERNAL_GOAL_MESSAGE_TIMES_KEY],
    sourceThreadValues[INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY]
  )
  const subagentTranscripts = filterSubagentTranscripts(
    sourceThreadValues[SUBAGENT_TRANSCRIPTS_KEY],
    transcriptIndex.subagentTranscriptIds
  )

  if (messageTimes) next[MESSAGE_TIMES_KEY] = messageTimes
  if (messageTimeOrder) next[MESSAGE_TIME_ORDER_KEY] = messageTimeOrder
  if (internalGoalMessageTimes) next[INTERNAL_GOAL_MESSAGE_TIMES_KEY] = internalGoalMessageTimes
  if (internalGoalMessageTimeOrder) {
    next[INTERNAL_GOAL_MESSAGE_TIME_ORDER_KEY] = internalGoalMessageTimeOrder
  }
  if (subagentTranscripts) next[SUBAGENT_TRANSCRIPTS_KEY] = subagentTranscripts

  return next
}
