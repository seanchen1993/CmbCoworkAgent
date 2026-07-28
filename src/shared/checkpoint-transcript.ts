import {
  buildMessageRoleCollisionId,
  buildMessageSameRoleDuplicateId,
  getMessageProviderOccurrence,
  getMessageProviderOccurrenceIdentity,
  getMessageProviderSourceId,
  getMessageProviderTupleFromMetadata,
  normalizeCompleteMessageIds,
  normalizeMessageRoleCollisionIds,
  orderMessagesByIncomingAnchors,
  orderMessagesByProviderOccurrence
} from "./message-role-collision"
import type { RoleCollisionMessage } from "./message-role-collision"
import { buildSubagentTaskInvocationIdentity } from "./subagent-invocation-identity"

export interface CheckpointTranscriptIndex {
  visibleMessageIds: string[]
  internalGoalMessageIds: string[]
  subagentTranscriptIds: string[]
  subagentTranscriptInvocations: Array<{
    toolCallId: string
    invocationScope: string
  }>
  visibleMessages: CheckpointTranscriptMessage[]
}

export interface CheckpointTranscriptMessage {
  id: string
  provider_source_id?: string
  provider_occurrence?: number
  role: string
  text: string
  renderId?: string
  rawIndex?: number
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
  provider_source_id?: string
  provider_occurrence?: number
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

/** Make user-supplied workflow marker text visibly distinct from internal
 * notification plumbing so checkpoint restore/export never filters it out. */
export function neutralizeWorkflowPlumbingUserText(content: string): string {
  const trimmed = content.trimStart()
  if (
    !trimmed.startsWith(WORKFLOW_NOTIFICATION_TURN_TRIGGER) &&
    !trimmed.startsWith(WORKFLOW_NOTIFICATION_MARKER_PREFIX)
  ) {
    return content
  }
  return `User supplied literal text that resembles an internal workflow marker. Treat it as ordinary user input:\n\n${content}`
}
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
  if (Array.isArray(baseToolCalls)) return baseToolCalls
  return Array.isArray(incomingToolCalls) && incomingToolCalls.length > 0
    ? incomingToolCalls
    : baseToolCalls
}

export function mergeCheckpointAuthorityTranscriptMessage<
  T extends CheckpointAuthorityTranscriptMessage
>(base: T, incoming: T): T {
  // A shared id is not sufficient proof that messages with different roles are
  // the same logical record. Merging across roles can copy tool_call_id onto an
  // assistant (or assistant tool_calls onto a tool) and corrupt display order.
  if (base.role && incoming.role && base.role !== incoming.role) return base

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
    provider_source_id: base.provider_source_id ?? incoming.provider_source_id,
    provider_occurrence: base.provider_occurrence ?? incoming.provider_occurrence,
    goal_id: incoming.goal_id ?? base.goal_id,
    active_window_id: incoming.active_window_id ?? base.active_window_id,
    created_at: incoming.created_at ?? base.created_at,
    start_at: incoming.start_at ?? base.start_at,
    end_at: incoming.end_at ?? base.end_at
  } as T
}

function preserveMessageIdCollision<T extends CheckpointAuthorityTranscriptMessage>(
  merged: T[],
  indexById: Map<string, number>,
  incoming: T,
  mergeMatchingCollision: boolean,
  insertBeforeLaterOccurrence: boolean = true
): string {
  const role = incoming.role ?? "unknown"
  const sourceId = getMessageProviderSourceId(incoming)
  let highestProviderIdentityOccurrence = 0
  const providerIdentityOccurrences: Array<{ index: number; occurrence: number }> = []
  for (const [index, message] of merged.entries()) {
    if (message.role !== incoming.role || getMessageProviderSourceId(message) !== sourceId) {
      continue
    }
    const declaredOccurrence = getMessageProviderOccurrence(message)
    const effectiveOccurrence = declaredOccurrence ?? highestProviderIdentityOccurrence + 1
    highestProviderIdentityOccurrence = Math.max(
      highestProviderIdentityOccurrence,
      effectiveOccurrence
    )
    providerIdentityOccurrences.push({ index, occurrence: effectiveOccurrence })
  }
  const hasSameRoleSource = highestProviderIdentityOccurrence > 0
  const declaredOccurrence = getMessageProviderOccurrence(incoming)
  let occurrence = hasSameRoleSource
    ? (declaredOccurrence ?? highestProviderIdentityOccurrence + 1)
    : (declaredOccurrence ?? 1)
  const collisionIdForOccurrence = (value: number): string =>
    hasSameRoleSource
      ? value === 1
        ? buildMessageRoleCollisionId(sourceId, role)
        : buildMessageSameRoleDuplicateId(sourceId, role, value)
      : buildMessageRoleCollisionId(sourceId, role, value > 1 ? value : undefined)
  let collisionId = collisionIdForOccurrence(occurrence)

  while (true) {
    const existingIndex = indexById.get(collisionId)
    if (existingIndex === undefined) {
      const preservedIncoming = {
        ...incoming,
        id: collisionId,
        ...(hasSameRoleSource
          ? { provider_source_id: sourceId, provider_occurrence: occurrence }
          : {})
      } as T
      const insertionIndex = insertBeforeLaterOccurrence
        ? providerIdentityOccurrences.find((candidate) => candidate.occurrence > occurrence)?.index
        : undefined
      if (insertionIndex === undefined) {
        merged.push(preservedIncoming)
        indexById.set(collisionId, merged.length - 1)
      } else {
        merged.splice(insertionIndex, 0, preservedIncoming)
        for (const [id, index] of indexById) {
          if (index >= insertionIndex) indexById.set(id, index + 1)
        }
        indexById.set(collisionId, insertionIndex)
      }
      return collisionId
    }

    const existing = merged[existingIndex]
    if (mergeMatchingCollision && existing.role === incoming.role) {
      merged[existingIndex] = mergeCheckpointAuthorityTranscriptMessage(existing, {
        ...incoming,
        id: collisionId,
        ...(hasSameRoleSource
          ? { provider_source_id: sourceId, provider_occurrence: occurrence }
          : {})
      } as T)
      return collisionId
    }

    occurrence += 1
    collisionId = collisionIdForOccurrence(occurrence)
  }
}

export function mergeCheckpointAuthorityTranscriptMessages<
  T extends CheckpointAuthorityTranscriptMessage
>(
  baseMessages: readonly T[],
  incomingMessages: readonly T[],
  options: { isSameMessage?: (left: T, right: T) => boolean } = {}
): T[] {
  const merged: T[] = []
  const indexById = new Map<string, number>()

  for (const message of normalizeCompleteMessageIds(baseMessages)) {
    const existingIndex = indexById.get(message.id)
    if (existingIndex === undefined) {
      merged.push(message)
      indexById.set(message.id, merged.length - 1)
      continue
    }

    const existing = merged[existingIndex]
    if (existing.role === message.role) {
      merged[existingIndex] = mergeCheckpointAuthorityTranscriptMessage(existing, message)
    } else {
      preserveMessageIdCollision(merged, indexById, message, false)
    }
  }

  if (incomingMessages.length === 0) return orderMessagesByProviderOccurrence(merged)
  const baselineIds = merged.map((message) => message.id)
  const baselineIdSet = new Set(baselineIds)
  const resolvedIncomingIds: string[] = []
  const recordIncomingOrderId = (
    resolvedId: string,
    rawId: string,
    allowBaselineAlias: boolean = false
  ): void => {
    if (!baselineIdSet.has(resolvedId) || resolvedId === rawId || allowBaselineAlias) {
      resolvedIncomingIds.push(resolvedId)
    }
  }
  let incomingSegmentStartsNewTurn = false

  // Callers provide transcript order explicitly (for example, the database
  // returns durable messages by ordinal). Provider timestamps can be missing or
  // non-monotonic, so re-sorting here would corrupt that authoritative order.
  for (const rawIncoming of incomingMessages) {
    const rawExistingIndex = indexById.get(rawIncoming.id)
    const rawExisting = rawExistingIndex === undefined ? undefined : merged[rawExistingIndex]
    const exactIdHasDifferentRole =
      Boolean(rawExisting?.role) &&
      Boolean(rawIncoming.role) &&
      rawExisting?.role !== rawIncoming.role

    // Checkpoint and durable transcripts can encounter the same provider-id
    // collision in different arrival orders. Normalize a missing/cross-role id
    // against the checkpoint baseline so source-id + role resolves to the same
    // internal row even when each source chose a different role to keep the raw
    // provider id. Keep exact same-role ids untouched because checkpoint data
    // can legitimately contain distinct same-role chunks with reused ids.
    const incoming =
      rawExistingIndex === undefined || exactIdHasDifferentRole
        ? (normalizeMessageRoleCollisionIds(merged, [rawIncoming])[0] ?? rawIncoming)
        : rawIncoming
    const incomingOccurrence = getMessageProviderOccurrence(incoming)
    const incomingSourceId = getMessageProviderSourceId(incoming)
    let highestProviderIdentityOccurrence = 0
    const providerIdentityCandidates = merged.flatMap((candidate, candidateIndex) => {
      if (
        candidate.role !== incoming.role ||
        getMessageProviderSourceId(candidate) !== incomingSourceId
      ) {
        return []
      }
      const declaredOccurrence = getMessageProviderOccurrence(candidate)
      const effectiveOccurrence = declaredOccurrence ?? highestProviderIdentityOccurrence + 1
      highestProviderIdentityOccurrence = Math.max(
        highestProviderIdentityOccurrence,
        effectiveOccurrence
      )
      return [{ candidateIndex, effectiveOccurrence }]
    })
    const effectiveIncomingOccurrence =
      incomingOccurrence ??
      (incoming.provider_source_id?.trim() &&
      providerIdentityCandidates.filter(
        ({ effectiveOccurrence }) => effectiveOccurrence === 1
      ).length === 1
        ? 1
        : undefined)
    const occurrenceMatches =
      effectiveIncomingOccurrence === undefined
        ? []
        : providerIdentityCandidates.flatMap(({ candidateIndex, effectiveOccurrence }) =>
            effectiveOccurrence === effectiveIncomingOccurrence
              ? [candidateIndex]
              : []
          )
    const occurrenceExistingIndex =
      occurrenceMatches.length === 1 ? occurrenceMatches[0] : undefined
    const exactExistingIndex = indexById.get(incoming.id)
    const exactExistingOccurrence =
      exactExistingIndex === undefined
        ? undefined
        : (providerIdentityCandidates.find(
            ({ candidateIndex }) => candidateIndex === exactExistingIndex
          )?.effectiveOccurrence ?? getMessageProviderOccurrence(merged[exactExistingIndex]))
    const exactExistingProviderSource =
      exactExistingIndex === undefined
        ? undefined
        : merged[exactExistingIndex].provider_source_id?.trim()
    const incomingExplicitProviderSource = incoming.provider_source_id?.trim()
    const exactIdHasSourceConflict =
      exactExistingIndex !== undefined &&
      Boolean(exactExistingProviderSource) &&
      Boolean(incomingExplicitProviderSource) &&
      exactExistingProviderSource !== incomingExplicitProviderSource
    const exactIdHasOccurrenceConflict =
      exactExistingIndex !== undefined &&
      exactExistingOccurrence !== undefined &&
      incomingOccurrence !== undefined &&
      exactExistingOccurrence !== incomingOccurrence
    const exactIdHasIdentityConflict =
      exactIdHasSourceConflict || exactIdHasOccurrenceConflict
    const existingIndex =
      (exactIdHasIdentityConflict ? undefined : exactExistingIndex) ??
      occurrenceExistingIndex
    if (incoming.role === "user") incomingSegmentStartsNewTurn = existingIndex === undefined
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex]
      if (existing.role && incoming.role && existing.role !== incoming.role) {
        // The checkpoint record keeps its provider id because checkpoint
        // boundaries reference it. Preserve the conflicting durable record
        // under a stable internal id so it still renders and repeated durable
        // syncs merge into the same row instead of duplicating it.
        const collisionId = preserveMessageIdCollision(
          merged,
          indexById,
          incoming,
          true,
          !incomingSegmentStartsNewTurn
        )
        recordIncomingOrderId(collisionId, rawIncoming.id)
        continue
      }
      merged[existingIndex] = mergeCheckpointAuthorityTranscriptMessage(existing, incoming)
      indexById.set(incoming.id, existingIndex)
      const hasUniqueExplicitTupleAnchor =
        existing.role === incoming.role &&
        Boolean(rawIncoming.provider_source_id?.trim()) &&
        getMessageProviderOccurrence(rawIncoming) !== undefined &&
        occurrenceMatches.length === 1
      recordIncomingOrderId(existing.id, rawIncoming.id, hasUniqueExplicitTupleAnchor)
      continue
    }
    if (exactIdHasIdentityConflict) {
      const collisionId = preserveMessageIdCollision(
        merged,
        indexById,
        incoming,
        false,
        !incomingSegmentStartsNewTurn
      )
      recordIncomingOrderId(collisionId, rawIncoming.id)
      continue
    }
    if (
      options.isSameMessage &&
      merged.some((message) => options.isSameMessage?.(message, incoming))
    ) {
      continue
    }
    const laterProviderOccurrenceIndex =
      incomingOccurrence === undefined || incomingSegmentStartsNewTurn
        ? undefined
        : providerIdentityCandidates.find(
            ({ effectiveOccurrence }) => effectiveOccurrence > incomingOccurrence
          )?.candidateIndex
    if (laterProviderOccurrenceIndex === undefined) {
      merged.push(incoming)
      indexById.set(incoming.id, merged.length - 1)
    } else {
      merged.splice(laterProviderOccurrenceIndex, 0, incoming)
      for (const [id, index] of indexById) {
        if (index >= laterProviderOccurrenceIndex) indexById.set(id, index + 1)
      }
      indexById.set(incoming.id, laterProviderOccurrenceIndex)
    }
    recordIncomingOrderId(incoming.id, rawIncoming.id)
  }

  return orderMessagesByProviderOccurrence(
    orderMessagesByIncomingAnchors(baselineIds, merged, resolvedIncomingIds)
  )
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

function getMessageToolCalls(message: Record<string, unknown>): unknown[] {
  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  const additionalKwargs = getAdditionalKwargs(message)
  if (Array.isArray(kwargs?.tool_calls)) return kwargs.tool_calls
  if (Array.isArray(message.tool_calls)) return message.tool_calls
  if (Array.isArray(additionalKwargs?.tool_calls)) return additionalKwargs.tool_calls
  return []
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

  const transcriptTarget = deriveCheckpointTranscriptIndex(checkpoint).visibleMessages.find(
    (message) => (message.renderId ?? message.id) === targetMessageId
  )
  const targetIndex =
    transcriptTarget?.rawIndex ??
    messages.findIndex((raw, index) => {
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
  const subagentTranscriptInvocations: Array<{
    toolCallId: string
    invocationScope: string
  }> = []
  const seenInvocations = new Set<string>()
  const parentOccurrenceCounts = new Map<string, number>()
  let idlessParentOccurrence = 0

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
    if (role === "assistant") {
      const kwargs = isRecord(raw.kwargs) ? raw.kwargs : undefined
      const parentMessageId = readString(kwargs?.id) ?? readString(raw.id)
      const providerOccurrence = getMessageProviderTupleFromMetadata(
        additionalKwargs
      )?.provider_occurrence
      let parentOccurrence: number
      if (providerOccurrence) {
        parentOccurrence = providerOccurrence
      } else if (parentMessageId) {
        parentOccurrence = (parentOccurrenceCounts.get(parentMessageId) ?? 0) + 1
        parentOccurrenceCounts.set(parentMessageId, parentOccurrence)
      } else {
        idlessParentOccurrence += 1
        parentOccurrence = idlessParentOccurrence
      }
      const toolCalls = getMessageToolCalls(raw)
      for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
        const toolCall = toolCalls[toolIndex]
        if (!isRecord(toolCall) || readString(toolCall.name) !== "task") continue
        const toolCallId = readString(toolCall.id)
        if (!toolCallId) continue
        const invocationScope = buildSubagentTaskInvocationIdentity({
          parentMessageId,
          parentOccurrence,
          parentContent: kwargs?.content ?? raw.content,
          parentToolCalls: toolCalls,
          taskToolCallId: toolCallId,
          taskToolCallIndex: toolIndex,
          taskArgs: toolCall.args
        })
        const invocationKey = JSON.stringify([toolCallId, invocationScope])
        if (seenInvocations.has(invocationKey)) continue
        seenInvocations.add(invocationKey)
        subagentTranscriptInvocations.push({ toolCallId, invocationScope })
      }
    }
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
      const providerTuple =
        role === "assistant"
          ? getMessageProviderTupleFromMetadata(additionalKwargs)
          : undefined
      visibleMessageIds.push(messageId)
      visibleMessages.push({
        id: messageId,
        ...providerTuple,
        role,
        text: stringifyContent(effectiveContent),
        rawIndex: index
      })
    }
  })

  const normalizedVisibleMessages = mergeCheckpointAuthorityTranscriptMessages(visibleMessages, [])
  const indexedVisibleMessages = visibleMessages.map((message, index) => ({
    ...message,
    renderId: normalizedVisibleMessages[index]?.id ?? message.id
  }))
  return {
    visibleMessageIds,
    internalGoalMessageIds,
    subagentTranscriptIds,
    subagentTranscriptInvocations,
    visibleMessages: indexedVisibleMessages
  }
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

  const target = transcript.visibleMessages.find(
    (message) => (message.renderId ?? message.id) === targetMessageId
  )
  if (!target) return missing("missing_message")
  if (target.role !== "assistant") {
    return {
      isForkableMessageBoundary: false,
      reason: "not_assistant",
      message: target,
      transcript
    }
  }
  const lastVisibleMessage = transcript.visibleMessages.at(-1)
  if ((lastVisibleMessage?.renderId ?? lastVisibleMessage?.id) !== targetMessageId) {
    return {
      isForkableMessageBoundary: false,
      reason: "not_visible_boundary",
      message: target,
      transcript
    }
  }

  const rawMessages = getCheckpointMessages(checkpoint)
  const targetRawIndex =
    target.rawIndex ??
    rawMessages.findIndex((raw, index) => {
      return isRecord(raw) && getMessageId(raw, index) === target.id
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

type CheckpointVisibleMessageBoundary = string | (RoleCollisionMessage & { renderId?: string })

function partitionMessageBoundaries(boundaries: readonly CheckpointVisibleMessageBoundary[]): {
  ids: Set<string>
  identities: Set<string>
} {
  const ids = new Set<string>()
  const identities = new Set<string>()

  for (const boundary of boundaries) {
    if (typeof boundary === "string") {
      if (boundary) ids.add(boundary)
      continue
    }
    const boundaryId = boundary.renderId || boundary.id
    if (!boundaryId) continue
    if (boundary.role || boundary.type) {
      identities.add(getMessageProviderOccurrenceIdentity({ ...boundary, id: boundaryId }))
    } else {
      ids.add(boundaryId)
    }
  }

  return { ids, identities }
}

export function findMessagesAfterCheckpointVisibleIds<
  T extends { id?: string; role?: string; type?: string }
>(
  messages: readonly T[],
  checkpointVisibleMessages: readonly CheckpointVisibleMessageBoundary[],
  options: {
    excludeMessageIds?: readonly string[]
    excludeMessages?: readonly RoleCollisionMessage[]
  } = {}
): T[] {
  if (checkpointVisibleMessages.length === 0) return []
  const checkpoint = partitionMessageBoundaries(checkpointVisibleMessages)
  const excluded = new Set(options.excludeMessageIds ?? [])
  const excludedIdentities = new Set(
    (options.excludeMessages ?? []).map(getMessageProviderOccurrenceIdentity)
  )
  let lastCheckpointMessageIndex = -1

  const hasCheckpointMessage = (message: T): boolean => {
    if (typeof message.id !== "string") return false
    if (checkpoint.ids.has(message.id)) return true
    if (checkpoint.identities.size === 0 || (!message.role && !message.type)) return false
    return checkpoint.identities.has(
      getMessageProviderOccurrenceIdentity(message as RoleCollisionMessage)
    )
  }

  messages.forEach((message, index) => {
    if (hasCheckpointMessage(message)) {
      lastCheckpointMessageIndex = index
    }
  })

  return messages.filter((message, index) => {
    if (typeof message.id !== "string") return false
    if (excluded.has(message.id)) return false
    if (
      excludedIdentities.size > 0 &&
      (message.role || message.type) &&
      excludedIdentities.has(
        getMessageProviderOccurrenceIdentity(message as RoleCollisionMessage)
      )
    ) {
      return false
    }
    if (hasCheckpointMessage(message)) return false
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
  ids: readonly string[],
  invocations: readonly { toolCallId: string; invocationScope: string }[]
): Record<string, unknown> | undefined {
  if (!isRecord(value) || ids.length === 0) return undefined
  const next: Record<string, unknown> = {}
  const rawIds = new Set(ids)
  const invocationKeys = new Set(
    invocations.map((invocation) =>
      JSON.stringify([invocation.toolCallId, invocation.invocationScope])
    )
  )
  for (const [executionId, transcript] of Object.entries(value)) {
    if (!Array.isArray(transcript)) continue
    const prompt = transcript.find(
      (message) =>
        isRecord(message) &&
        typeof message.subagent_tool_call_id === "string" &&
        typeof message.subagent_invocation_scope === "string"
    )
    if (isRecord(prompt)) {
      const key = JSON.stringify([
        prompt.subagent_tool_call_id,
        prompt.subagent_invocation_scope
      ])
      if (invocationKeys.has(key)) {
        next[executionId] = cloneJsonValue(transcript)
        continue
      }
      // Pre-v1 metadata stored a mutable UI render ID. It cannot be compared to
      // the shared checkpoint identity, so retain its raw family conservatively.
      if (
        typeof prompt.subagent_invocation_scope === "string" &&
        prompt.subagent_invocation_scope.startsWith("task-v1-")
      ) {
        continue
      }
    }

    // Legacy buckets have no parent identity. Preserve the matching raw-ID
    // family rather than silently dropping scoped historical records; new
    // records use the exact invocation path above and do not leak past a fork.
    const scopedMatch = /^(.*)::(?:execution-\d+|invocation-[a-z0-9-]+)$/.exec(executionId)
    const promptToolCallId =
      isRecord(prompt) && typeof prompt.subagent_tool_call_id === "string"
        ? prompt.subagent_tool_call_id
        : undefined
    const rawToolCallId = promptToolCallId ?? scopedMatch?.[1] ?? executionId
    if (rawIds.has(rawToolCallId)) next[executionId] = cloneJsonValue(transcript)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function buildFilteredThreadValues(
  sourceThreadValues: Record<string, unknown> | null | undefined,
  transcriptIndex: CheckpointTranscriptIndex
): Record<string, unknown> {
  if (!isRecord(sourceThreadValues)) return {}

  const next: Record<string, unknown> = {}
  const visibleRenderMessageIds = transcriptIndex.visibleMessages.map(
    (message) => message.renderId ?? message.id
  )
  const messageTimes = filterTimeMap(sourceThreadValues[MESSAGE_TIMES_KEY], visibleRenderMessageIds)
  const internalGoalMessageTimes = filterTimeMap(
    sourceThreadValues[INTERNAL_GOAL_MESSAGE_TIMES_KEY],
    transcriptIndex.internalGoalMessageIds
  )
  const messageTimeOrder = buildOrder(
    visibleRenderMessageIds,
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
    transcriptIndex.subagentTranscriptIds,
    transcriptIndex.subagentTranscriptInvocations
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
