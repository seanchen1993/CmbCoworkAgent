import type { Message, Subagent } from "../types"
import {
  getMessageProviderOccurrence,
  getMessageProviderSourceId,
  normalizeAppendedMessageIds,
  normalizeCompleteMessageIds,
  normalizeCompleteSnapshotMessageIds,
  orderMessagesByProviderOccurrence
} from "../../../shared/message-role-collision"
import {
  isSubagentTranscriptBlobRef,
  projectSubagentDescription,
  projectSubagentTranscriptContentForStorage,
  SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY
} from "../../../shared/subagent-transcript-storage"

export {
  projectSubagentTranscriptBoundaries,
  projectSubagentTranscriptContent,
  SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY
} from "../../../shared/subagent-transcript-storage"

const MAX_TRANSCRIPT_REPLACEMENT_ALIASES = 8

/**
 * Drain transcript changes in batches. Callers atomically detach the currently
 * dirty ids in `takePending`; changes arriving while one write is in flight are
 * therefore coalesced into the next (and usually only one additional) write.
 */
export async function drainCoalescedSubagentTranscriptChanges(
  takePending: () => Set<string> | undefined,
  persist: (changedIds: Set<string>) => Promise<void>
): Promise<void> {
  while (true) {
    const changedIds = takePending()
    if (!changedIds?.size) return
    await persist(changedIds)
  }
}

function restoredSubagentName(subagentType: string): string {
  const knownNames: Record<string, string> = {
    "general-purpose": "General Purpose Agent",
    "correctness-checker": "Correctness Checker",
    "final-reviewer": "Final Reviewer",
    "code-reviewer": "Code Reviewer",
    research: "Research Agent"
  }
  return (
    knownNames[subagentType] ||
    subagentType
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  )
}

/** Rebuild read-only cards so hydrated transcript buckets remain reachable after reload. */
export function restoreSubagentsFromTranscripts(
  transcripts: Record<string, Message[]>,
  existingSubagents: Subagent[] = []
): Subagent[] {
  const restored = [...existingSubagents]
  let spawnIndex = existingSubagents.reduce(
    (maximum, subagent) => Math.max(maximum, (subagent.spawnIndex ?? -1) + 1),
    0
  )

  for (const [subagentId, messages] of Object.entries(transcripts)) {
    if (messages.length === 0) continue
    const prompt = messages.find(
      (message) =>
        message.role === "user" &&
        (message.id === `subagent-prompt-${subagentId}` || !!message.subagent_tool_call_id)
    )
    const final = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" &&
          (message.id === `subagent-final-${subagentId}` ||
            ((message.content_priority ?? 0) >= 1 &&
              (message.status !== undefined || message.is_error === true)))
      )
    const firstMessage = messages[0]
    const lastMessage = messages[messages.length - 1]
    const subagentType = prompt?.subagent_type || "general-purpose"
    const promptContent = typeof prompt?.content === "string" ? prompt.content : ""
    const scopedExecutionMatch = /^(.*)::(?:execution-\d+|invocation-[a-z0-9-]+)$/.exec(
      subagentId
    )
    const cardToolCallId = scopedExecutionMatch?.[1] ?? subagentId
    const isFailed = final?.is_error === true || final?.status === "error"
    const isCancelled = final?.status === "cancelled"
    const terminalStatus: Subagent["status"] = final
      ? isFailed
        ? "failed"
        : isCancelled
          ? "cancelled"
          : "completed"
      : "cancelled"
    const existingIndex = restored.findIndex((subagent) => subagent.id === subagentId)
    if (existingIndex >= 0) {
      const existing = restored[existingIndex]
      // A stable final row is authoritative even if a missed parent `done`
      // previously downgraded the still-running card to cancelled. Without a
      // final, retain live state; the parent-stop path decides cancellation.
      restored[existingIndex] = {
        ...existing,
        ...(prompt?.subagent_name && { name: prompt.subagent_name }),
        ...(prompt?.subagent_description && {
          description: prompt.subagent_description
        }),
        ...(prompt?.subagent_type && { subagentType: prompt.subagent_type }),
        ...(final && {
          status: terminalStatus,
          completedAt: final.created_at,
          restoredFromPromptOnly: undefined
        })
      }
      continue
    }
    restored.push({
      id: subagentId,
      toolCallId: cardToolCallId,
      name: prompt?.subagent_name || restoredSubagentName(subagentType),
      description:
        prompt?.subagent_description ||
        projectSubagentDescription(promptContent) ||
        "已恢复的子代理任务",
      status: terminalStatus,
      startedAt: prompt?.created_at ?? firstMessage.created_at,
      completedAt: final?.created_at ?? lastMessage.created_at,
      subagentType,
      spawnIndex,
      ...(!final && { restoredFromPromptOnly: true })
    })
    spawnIndex += 1
  }
  return restored
}

function messageContentLength(content: Message["content"] | undefined): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, block) => {
    if (typeof block.text === "string") return total + block.text.length
    if (typeof block.content === "string") return total + block.content.length
    return total
  }, 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasNonEmptyArgs(args: unknown): args is Record<string, unknown> {
  return isRecord(args) && Object.keys(args).length > 0
}

function mergeToolCallArgs(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (hasNonEmptyArgs(incoming)) return incoming
  if (hasNonEmptyArgs(existing)) return existing
  return incoming ?? existing ?? {}
}

function mergeTranscriptToolCalls(
  existing: Message["tool_calls"] | undefined,
  incoming: Message["tool_calls"] | undefined
): Message["tool_calls"] | undefined {
  if (!incoming || incoming.length === 0) return existing
  if (!existing || existing.length === 0) return incoming

  const next = [...existing]
  const indexById = new Map<string, number>()
  next.forEach((toolCall, index) => {
    if (toolCall.id) indexById.set(toolCall.id, index)
  })

  for (const toolCall of incoming) {
    const existingIndex = toolCall.id ? indexById.get(toolCall.id) : undefined
    if (existingIndex !== undefined) {
      next[existingIndex] = {
        ...next[existingIndex],
        ...toolCall,
        args: mergeToolCallArgs(next[existingIndex].args, toolCall.args)
      }
      continue
    }
    if (toolCall.id) indexById.set(toolCall.id, next.length)
    next.push(toolCall)
  }

  return next
}

function followingToolMessages(messages: Message[], assistantIndex: number): Message[] {
  const result: Message[] = []
  for (let index = assistantIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "tool") break
    if (message.tool_call_id) result.push(message)
  }
  return result
}

function findMatchingToolMessageIndex(
  toolCall: NonNullable<Message["tool_calls"]>[number],
  toolMessages: Message[],
  usedIndexes: Set<number>,
  toolCallIndex: number,
  toolCallCount: number
): number | undefined {
  const namedMatchIndex = toolMessages.findIndex(
    (message, index) =>
      !usedIndexes.has(index) &&
      Boolean(message.tool_call_id) &&
      Boolean(toolCall.name) &&
      message.name === toolCall.name
  )
  if (namedMatchIndex >= 0) return namedMatchIndex

  if (
    toolMessages.length === toolCallCount &&
    toolMessages[toolCallIndex]?.tool_call_id &&
    !usedIndexes.has(toolCallIndex)
  ) {
    return toolCallIndex
  }

  if (toolCallCount === 1 && toolMessages.length === 1 && !usedIndexes.has(0)) {
    return 0
  }

  return undefined
}

function dedupeToolCallsById(
  toolCalls: NonNullable<Message["tool_calls"]>
): NonNullable<Message["tool_calls"]> {
  const result: NonNullable<Message["tool_calls"]> = []
  const indexById = new Map<string, number>()

  for (const toolCall of toolCalls) {
    if (!toolCall.id) {
      result.push(toolCall)
      continue
    }

    const existingIndex = indexById.get(toolCall.id)
    if (existingIndex === undefined) {
      indexById.set(toolCall.id, result.length)
      result.push(toolCall)
      continue
    }

    const existing = result[existingIndex]
    result[existingIndex] = {
      ...existing,
      ...toolCall,
      name: toolCall.name || existing.name,
      args: mergeToolCallArgs(existing.args, toolCall.args)
    }
  }

  return result
}

export function getSubagentTranscriptDisplayStats(messages: Message[]): {
  visibleMessageCount: number
  toolCallCount: number
  toolResultCount: number
} {
  let visibleMessageCount = 0
  let toolCallCount = 0
  let toolResultCount = 0

  for (const message of messages) {
    if (message.role === "tool") {
      toolResultCount += 1
      continue
    }
    visibleMessageCount += 1
    toolCallCount += message.tool_calls?.length ?? 0
  }

  return { visibleMessageCount, toolCallCount, toolResultCount }
}

export function reconcileTranscriptToolCallsWithResults(messages: Message[]): Message[] {
  let changed = false
  const reconciled = messages.map((message, index) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message

    const toolMessages = followingToolMessages(messages, index)
    if (toolMessages.length === 0) return message

    const usedToolMessageIndexes = new Set<number>()
    const exactResultIds = new Set(toolMessages.map((toolMessage) => toolMessage.tool_call_id))
    const nextToolCalls = message.tool_calls.map((toolCall, toolCallIndex) => {
      if (toolCall.id && exactResultIds.has(toolCall.id)) {
        const exactIndex = toolMessages.findIndex(
          (toolMessage) => toolMessage.tool_call_id === toolCall.id
        )
        if (exactIndex >= 0) usedToolMessageIndexes.add(exactIndex)
        return toolCall
      }

      const matchIndex = findMatchingToolMessageIndex(
        toolCall,
        toolMessages,
        usedToolMessageIndexes,
        toolCallIndex,
        message.tool_calls!.length
      )
      if (matchIndex === undefined) return toolCall

      const toolMessage = toolMessages[matchIndex]
      if (!toolMessage.tool_call_id) return toolCall

      usedToolMessageIndexes.add(matchIndex)
      changed = true
      return {
        ...toolCall,
        id: toolMessage.tool_call_id,
        name: toolCall.name || toolMessage.name || "tool"
      }
    })

    const dedupedToolCalls = dedupeToolCallsById(nextToolCalls)
    if (dedupedToolCalls.length !== nextToolCalls.length) changed = true
    return changed ? { ...message, tool_calls: dedupedToolCalls } : message
  })

  return changed ? reconciled : messages
}

export function mergeTranscriptMessage(existing: Message, incoming: Message): Message {
  const existingContentLength = messageContentLength(existing.content)
  const incomingContentLength = messageContentLength(incoming.content)
  const existingContentPriority = existing.content_priority ?? 0
  const incomingContentPriority = incoming.content_priority ?? 0
  const incomingHasContent = incomingContentLength > 0
  const preservesExistingError = existing.is_error === true && incoming.is_error !== true
  const tightensToError = incoming.is_error === true && existing.is_error !== true
  const existingIsProjection = existing.content_is_projection === true
  const incomingIsProjection = incoming.content_is_projection === true
  const existingContentRef = isSubagentTranscriptBlobRef(existing.content_ref, "content")
    ? existing.content_ref
    : undefined
  const incomingContentRef = isSubagentTranscriptBlobRef(incoming.content_ref, "content")
    ? incoming.content_ref
    : undefined
  const contentRefChanged =
    !!existingContentRef &&
    !!incomingContentRef &&
    existingContentRef.sha256 !== incomingContentRef.sha256
  const blocksIncomingContentProjection =
    !existingIsProjection && incomingIsProjection && !contentRefChanged && !tightensToError
  const shouldUseIncomingContent =
    !preservesExistingError &&
    ((incomingContentPriority > existingContentPriority && incomingHasContent) ||
      (incomingContentPriority === existingContentPriority &&
        ((existingIsProjection && !incomingIsProjection && incomingHasContent) ||
          (!blocksIncomingContentProjection &&
            (incomingContentPriority > 0
              ? incomingHasContent
              : incomingContentLength >= existingContentLength)))))
  const existingReasoningRef = isSubagentTranscriptBlobRef(
    existing.reasoning_ref,
    "reasoning"
  )
    ? existing.reasoning_ref
    : undefined
  const incomingReasoningRef = isSubagentTranscriptBlobRef(
    incoming.reasoning_ref,
    "reasoning"
  )
    ? incoming.reasoning_ref
    : undefined
  const reasoningRefChanged =
    !!existingReasoningRef &&
    !!incomingReasoningRef &&
    existingReasoningRef.sha256 !== incomingReasoningRef.sha256
  const shouldUseIncomingReasoning =
    typeof incoming.reasoning === "string" &&
    !(
      incoming.reasoning_is_projection === true &&
      existing.reasoning_is_projection !== true &&
      !reasoningRefChanged &&
      !tightensToError
    )
  const existingToolCallsRef = isSubagentTranscriptBlobRef(
    existing.tool_calls_ref,
    "tool_calls"
  )
    ? existing.tool_calls_ref
    : undefined
  const incomingToolCallsRef = isSubagentTranscriptBlobRef(
    incoming.tool_calls_ref,
    "tool_calls"
  )
    ? incoming.tool_calls_ref
    : undefined
  const toolCallsRefChanged =
    !!existingToolCallsRef &&
    !!incomingToolCallsRef &&
    existingToolCallsRef.sha256 !== incomingToolCallsRef.sha256
  const shouldUseIncomingToolCalls =
    incoming.tool_calls !== undefined || toolCallsRefChanged || tightensToError
  const nextContentIsProjection = shouldUseIncomingContent
    ? incoming.content_is_projection
    : existing.content_is_projection
  const nextReasoningIsProjection = shouldUseIncomingReasoning
    ? incoming.reasoning_is_projection
    : existing.reasoning_is_projection
  const nextStartupToolCallsProjection =
    incoming.subagent_startup_tool_calls_projection === true
      ? true
      : shouldUseIncomingToolCalls
        ? undefined
        : existing.subagent_startup_tool_calls_projection
  const retainsStartupProjection =
    (existing.subagent_startup_projection === true ||
      incoming.subagent_startup_projection === true) &&
    (nextContentIsProjection === true ||
      nextReasoningIsProjection === true ||
      nextStartupToolCallsProjection === true)
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    content: shouldUseIncomingContent
      ? (incoming.content ?? existing.content)
      : (existing.content ?? incoming.content),
    content_is_projection: nextContentIsProjection,
    content_full_length: shouldUseIncomingContent
      ? incoming.content_full_length
      : existing.content_full_length,
    content_ref: shouldUseIncomingContent ? incoming.content_ref : existing.content_ref,
    subagent_content_fingerprint: shouldUseIncomingContent
      ? incoming.subagent_content_fingerprint
      : existing.subagent_content_fingerprint,
    reasoning: shouldUseIncomingReasoning
      ? incoming.reasoning
      : (existing.reasoning ?? incoming.reasoning),
    reasoning_is_projection: nextReasoningIsProjection,
    reasoning_full_length: shouldUseIncomingReasoning
      ? incoming.reasoning_full_length
      : existing.reasoning_full_length,
    reasoning_ref: shouldUseIncomingReasoning ? incoming.reasoning_ref : existing.reasoning_ref,
    subagent_reasoning_fingerprint: shouldUseIncomingReasoning
      ? incoming.subagent_reasoning_fingerprint
      : existing.subagent_reasoning_fingerprint,
    content_priority: preservesExistingError
      ? existing.content_priority
      : incomingContentPriority >= existingContentPriority
        ? (incoming.content_priority ?? existing.content_priority)
        : existing.content_priority,
    replaced_message_ids: preservesExistingError
      ? existing.replaced_message_ids
      : tightensToError
        ? incoming.replaced_message_ids
      : mergeTranscriptReplacementAliases(
          existing.replaced_message_ids,
          incoming.replaced_message_ids
        ),
    replaced_message_id_prefixes: preservesExistingError
      ? existing.replaced_message_id_prefixes
      : tightensToError
        ? incoming.replaced_message_id_prefixes
      : mergeTranscriptReplacementAliases(
          existing.replaced_message_id_prefixes,
          incoming.replaced_message_id_prefixes
        ),
    compatible_replaced_message_id_prefixes: preservesExistingError
      ? existing.compatible_replaced_message_id_prefixes
      : tightensToError
        ? incoming.compatible_replaced_message_id_prefixes
      : mergeTranscriptReplacementAliases(
          existing.compatible_replaced_message_id_prefixes,
          incoming.compatible_replaced_message_id_prefixes
        ),
    tool_calls: shouldUseIncomingToolCalls
      ? incoming.tool_calls === undefined
        ? undefined
        : mergeTranscriptToolCalls(
            toolCallsRefChanged || tightensToError ? undefined : existing.tool_calls,
            incoming.tool_calls
          )
      : existing.tool_calls,
    tool_calls_ref: shouldUseIncomingToolCalls
      ? incoming.tool_calls_ref
      : existing.tool_calls_ref,
    status: preservesExistingError ? existing.status : (incoming.status ?? existing.status),
    is_error: preservesExistingError ? true : (incoming.is_error ?? existing.is_error),
    subagent_startup_projection: retainsStartupProjection ? true : undefined,
    subagent_startup_tool_calls_projection: nextStartupToolCallsProjection,
    created_at: existing.created_at ?? incoming.created_at
  }
}

/** Concatenate contiguous persisted pages without letting duplicate ids reorder rows. */
export function mergeSubagentTranscriptPages(
  earlier: Message[],
  later: Message[]
): Message[] {
  // These are contiguous persisted ranges, not a sparse baseline + snapshot.
  // Canonicalize the concatenated source order once so cross-page collisions
  // and replacement aliases produce the same order as a one-shot hydration.
  return upsertTranscriptMessages([], [...earlier, ...later], {
    completeSnapshot: true
  })
}

function isOpeningSubagentPrompt(message: Message): boolean {
  return (
    message.role === "user" &&
    (message.id.startsWith("subagent-prompt-") || !!message.subagent_tool_call_id)
  )
}

/**
 * Overlay startup/live rows on a contiguous persisted page. Missing prompt rows
 * are pinned before the page; live-only rows belong after it. This avoids the
 * generic sparse-snapshot anchor logic moving a prompt next to the final row.
 */
export function mergePaginatedSubagentTranscript(
  persistedPage: Message[],
  startupAndLiveMessages: Message[]
): Message[] {
  const mergedPage = mergeSubagentTranscriptPages([], persistedPage)
  const indexById = new Map(mergedPage.map((message, index) => [message.id, index]))
  const prefix: Message[] = []
  const suffix: Message[] = []
  for (const message of startupAndLiveMessages) {
    const existingIndex = indexById.get(message.id)
    if (existingIndex !== undefined) {
      mergedPage[existingIndex] = mergeTranscriptMessage(mergedPage[existingIndex], message)
    } else if (isOpeningSubagentPrompt(message)) {
      prefix.push(message)
    } else {
      suffix.push(message)
    }
  }
  return mergeSubagentTranscriptPages(
    mergeSubagentTranscriptPages([], prefix),
    mergeSubagentTranscriptPages(mergedPage, suffix)
  )
}

/** Pick the canonical, post-merge rows corresponding to a live delta. */
export function selectMergedTranscriptRowsForPersistence(
  mergedMessages: Message[],
  incomingMessages: Message[]
): Message[] {
  const selected: Message[] = []
  const selectedIds = new Set<string>()
  for (const incoming of incomingMessages) {
    const sourceId = getMessageProviderSourceId(incoming)
    const occurrence = getMessageProviderOccurrence(incoming)
    const candidate = mergedMessages.findLast((message) => {
      if (message.role !== incoming.role) return false
      if (message.id === incoming.id) return true
      if (message.replaced_message_ids?.includes(incoming.id)) return true
      if (getMessageProviderSourceId(message) !== sourceId) return false
      const candidateOccurrence = getMessageProviderOccurrence(message)
      return occurrence === undefined || candidateOccurrence === occurrence
    })
    if (candidate && !selectedIds.has(candidate.id)) {
      selectedIds.add(candidate.id)
      selected.push(candidate)
    }
  }
  return selected
}

/**
 * Re-resolve live deltas against the hydrated durable baseline. History and
 * live events can race during startup, so a pending status-only row may have
 * been captured before its full content/ref-bearing counterpart was loaded.
 */
export function rebasePendingSubagentTranscriptRows(
  mergedTranscripts: Record<string, Message[]>,
  pendingBySubagent: Record<string, Message[]>
): Record<string, Message[]> {
  return Object.fromEntries(
    Object.entries(pendingBySubagent).flatMap(([subagentId, pendingMessages]) => {
      const selected = selectMergedTranscriptRowsForPersistence(
        mergedTranscripts[subagentId] ?? [],
        pendingMessages
      )
      const rebased = selected.length > 0 ? selected : pendingMessages
      return rebased.length > 0 ? [[subagentId, rebased] as const] : []
    })
  )
}

export type SubagentTranscriptPersistFollowUp = "none" | "immediate" | "debounced"

export function selectSubagentTranscriptPersistFollowUp(input: {
  attemptFailed: boolean
  hasPending: boolean
  canPersist: boolean
  timerScheduled: boolean
  hasUrgent: boolean
}): SubagentTranscriptPersistFollowUp {
  if (
    input.attemptFailed ||
    !input.hasPending ||
    !input.canPersist ||
    input.timerScheduled
  ) {
    return "none"
  }
  return input.hasUrgent ? "immediate" : "debounced"
}

export interface UpsertTranscriptMessagesOptions {
  completeSnapshot?: boolean
}

function mergeTranscriptReplacementAliases(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined
): string[] | undefined {
  const aliases = [...(existing ?? []), ...(incoming ?? [])]
    .filter((alias) => typeof alias === "string" && alias.trim())
    .filter((alias, index, all) => all.indexOf(alias) === index)
    .slice(-MAX_TRANSCRIPT_REPLACEMENT_ALIASES)
  return aliases.length > 0 ? aliases : undefined
}

type TranscriptReplacementInstruction = Message & {
  replaces_message_id?: unknown
  replaces_message_id_prefix?: unknown
  replacement_mode?: unknown
}

function readReplacementString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function stripTranscriptReplacementInstruction(message: Message): Message {
  const stripped = { ...message } as TranscriptReplacementInstruction
  delete stripped.replaces_message_id
  delete stripped.replaces_message_id_prefix
  delete stripped.replacement_mode
  return stripped
}

function canReplaceTranscriptAssistant(message: Message): boolean {
  return message.role === "assistant" && !message.tool_calls?.length
}

function replacementContentsAreCompatible(candidate: Message, finalMessage: Message): boolean {
  if (typeof candidate.content !== "string" || typeof finalMessage.content !== "string") {
    return false
  }
  const candidateContent = candidate.content.trim()
  const finalContent = finalMessage.content.trim()
  if (!candidateContent || !finalContent) return false
  if (
    candidate.content_is_projection === true &&
    candidate.content_full_length === finalMessage.content.length
  ) {
    const marker = /\n…\[省略 (\d+) 字\]…\n/.exec(candidate.content)
    if (marker?.index !== undefined) {
      const markerEnd = marker.index + marker[0].length
      const head = candidate.content.slice(0, marker.index)
      const tail = candidate.content.slice(markerEnd)
      const omitted = Number(marker[1])
      if (
        Number.isSafeInteger(omitted) &&
        omitted >= 0 &&
        head.length + omitted + tail.length === finalMessage.content.length &&
        finalMessage.content.startsWith(head) &&
        finalMessage.content.endsWith(tail)
      ) {
        return true
      }
    }
  }
  return (
    candidateContent === finalContent ||
    candidateContent.startsWith(finalContent) ||
    finalContent.startsWith(candidateContent)
  )
}

interface TranscriptPrefixAlias {
  prefix: string
  targetId: string
  targetPriority: number
  origin: "baseline" | "incoming" | "instruction"
  compatibleOnly: boolean
}

function canonicalizeTranscriptMessages(
  messages: readonly Message[],
  exactAliases: ReadonlyMap<string, string>,
  prefixAliases: readonly TranscriptPrefixAlias[]
): Message[] {
  const aliasTargetIds = new Set<string>([
    ...exactAliases.values(),
    ...prefixAliases.map((alias) => alias.targetId)
  ])
  const resolveId = (message: Message): string => {
    if (!canReplaceTranscriptAssistant(message)) return message.id
    let resolved = message.id
    const visited = new Set<string>()
    while (!visited.has(resolved)) {
      visited.add(resolved)
      const exact = exactAliases.get(resolved)
      if (!exact) break
      resolved = exact
    }
    if (resolved !== message.id) return resolved

    return message.id
  }

  const records = messages.map((rawMessage, index) => {
    const message = stripTranscriptReplacementInstruction(rawMessage)
    const canonicalId = resolveId(message)
    const isReplacementSource = canonicalId !== message.id
    const normalized: Message = {
      ...message,
      id: canonicalId,
      ...(isReplacementSource && {
        replaced_message_ids: mergeTranscriptReplacementAliases(
          message.replaced_message_ids,
          [message.id]
        )
      })
    }
    return { message: normalized, canonicalId, index, isReplacementSource }
  })

  const replacementGroups = new Map<
    string,
    { message: Message; anchorIndex: number; firstIndex: number; hasSourceAnchor: boolean }
  >()
  const output: Array<{
    message: Message
    anchorIndex: number
    firstIndex: number
    hasSourceAnchor?: boolean
  }> = []
  for (const record of records) {
    if (!aliasTargetIds.has(record.canonicalId)) {
      output.push({
        message: record.message,
        anchorIndex: record.index,
        firstIndex: record.index,
        hasSourceAnchor: record.isReplacementSource
      })
      continue
    }
    const existing = replacementGroups.get(record.canonicalId)
    if (!existing) {
      replacementGroups.set(record.canonicalId, {
        message: record.message,
        anchorIndex: record.index,
        firstIndex: record.index,
        hasSourceAnchor: record.isReplacementSource
      })
      continue
    }
    existing.message = mergeTranscriptMessage(existing.message, record.message)
    if (record.isReplacementSource && !existing.hasSourceAnchor) {
      existing.anchorIndex = record.index
      existing.hasSourceAnchor = true
    }
  }
  output.push(...replacementGroups.values())
  return output
    .sort(
      (left, right) =>
        left.anchorIndex - right.anchorIndex || left.firstIndex - right.firstIndex
    )
    .map((entry) => entry.message)
}

function prepareTranscriptReplacements(
  baseline: Message[],
  incoming: Message[]
): { baseline: Message[]; incoming: Message[] } {
  const pending = incoming.map((original) => ({
    original: original as TranscriptReplacementInstruction,
    message: stripTranscriptReplacementInstruction(original)
  }))
  const allMessages = [...baseline, ...pending.map((entry) => entry.message)]
  const exactAliases = new Map<string, string>()
  const prefixAliases: TranscriptPrefixAlias[] = []

  const registerExactAlias = (sourceId: string, targetId: string): boolean => {
    if (!sourceId || sourceId === targetId) return false
    const existingTarget = exactAliases.get(sourceId)
    if (existingTarget) return existingTarget === targetId
    let cursor = targetId
    const visited = new Set<string>()
    while (!visited.has(cursor)) {
      if (cursor === sourceId) return false
      visited.add(cursor)
      const next = exactAliases.get(cursor)
      if (!next) break
      cursor = next
    }
    exactAliases.set(sourceId, targetId)
    return true
  }

  const registerPrefixAlias = (
    prefix: string,
    targetId: string,
    targetPriority: number,
    origin: TranscriptPrefixAlias["origin"],
    compatibleOnly: boolean
  ): void => {
    const existing = prefixAliases.find(
      (alias) => alias.prefix === prefix && alias.targetId === targetId
    )
    if (existing) {
      if (origin === "instruction") existing.origin = origin
      existing.targetPriority = Math.max(existing.targetPriority, targetPriority)
      existing.compatibleOnly = existing.compatibleOnly && compatibleOnly
      return
    }
    prefixAliases.push({ prefix, targetId, targetPriority, origin, compatibleOnly })
  }

  for (const message of baseline) {
    if (!canReplaceTranscriptAssistant(message)) continue
    for (const sourceId of message.replaced_message_ids ?? []) {
      registerExactAlias(sourceId, message.id)
    }
    for (const prefix of message.replaced_message_id_prefixes ?? []) {
      registerPrefixAlias(
        prefix,
        message.id,
        message.content_priority ?? 0,
        "baseline",
        message.is_error === true
      )
    }
    for (const prefix of message.compatible_replaced_message_id_prefixes ?? []) {
      registerPrefixAlias(prefix, message.id, message.content_priority ?? 0, "baseline", true)
    }
  }
  for (const entry of pending) {
    const message = entry.message
    if (!canReplaceTranscriptAssistant(message)) continue
    for (const sourceId of message.replaced_message_ids ?? []) {
      registerExactAlias(sourceId, message.id)
    }
    for (const prefix of message.replaced_message_id_prefixes ?? []) {
      registerPrefixAlias(
        prefix,
        message.id,
        message.content_priority ?? 0,
        "incoming",
        message.is_error === true
      )
    }
    for (const prefix of message.compatible_replaced_message_id_prefixes ?? []) {
      registerPrefixAlias(prefix, message.id, message.content_priority ?? 0, "incoming", true)
    }
  }

  for (const entry of pending) {
    const finalMessage = entry.message
    if (!canReplaceTranscriptAssistant(finalMessage)) continue
    const replacementId = readReplacementString(entry.original.replaces_message_id)
    const replacementPrefix = readReplacementString(
      entry.original.replaces_message_id_prefix
    )
    const compatibleOnly = entry.original.replacement_mode === "compatible"
    const finalPriority = finalMessage.content_priority ?? 0
    const candidates = allMessages.filter(
      (candidate) =>
        candidate !== finalMessage &&
        canReplaceTranscriptAssistant(candidate) &&
        (candidate.content_priority ?? 0) < finalPriority
    )
    const candidate =
      (replacementId
        ? candidates.findLast((message) => message.id === replacementId)
        : undefined) ??
      (replacementPrefix
        ? candidates.findLast((message) => message.id.startsWith(replacementPrefix))
        : undefined)
    const canUseCandidate =
      !!candidate &&
      (!compatibleOnly || replacementContentsAreCompatible(candidate, finalMessage))

    if (
      replacementId &&
      (!compatibleOnly || canUseCandidate) &&
      registerExactAlias(replacementId, finalMessage.id)
    ) {
      entry.message = {
        ...entry.message,
        replaced_message_ids: mergeTranscriptReplacementAliases(
          entry.message.replaced_message_ids,
          [replacementId]
        )
      }
    }

    if (
      candidate &&
      candidate.id !== replacementId &&
      canUseCandidate &&
      registerExactAlias(candidate.id, finalMessage.id)
    ) {
      entry.message = {
        ...entry.message,
        replaced_message_ids: mergeTranscriptReplacementAliases(
          entry.message.replaced_message_ids,
          [candidate.id]
        )
      }
    }
    if (replacementPrefix) {
      registerPrefixAlias(
        replacementPrefix,
        finalMessage.id,
        finalPriority,
        "instruction",
        compatibleOnly
      )
      entry.message = compatibleOnly
        ? {
            ...entry.message,
            compatible_replaced_message_id_prefixes: mergeTranscriptReplacementAliases(
              entry.message.compatible_replaced_message_id_prefixes,
              [replacementPrefix]
            )
          }
        : {
            ...entry.message,
            replaced_message_id_prefixes: mergeTranscriptReplacementAliases(
              entry.message.replaced_message_id_prefixes,
              [replacementPrefix]
            )
          }
    }
  }

  // A persisted prefix is a recovery hint, not a wildcard alias. Resolve only
  // the latest eligible provisional row to an exact alias on each upsert; older
  // plain assistant turns sharing the task prefix must remain distinct.
  for (const alias of prefixAliases) {
    const targetMessage = allMessages.findLast((message) => message.id === alias.targetId)
    const candidatePool =
      alias.origin === "instruction"
        ? allMessages
        : alias.origin === "baseline"
          ? pending.map((entry) => entry.message)
          : baseline
    const candidate = candidatePool.findLast(
      (message) =>
        message.id !== alias.targetId &&
        message.id.startsWith(alias.prefix) &&
        canReplaceTranscriptAssistant(message) &&
        (message.content_priority ?? 0) < alias.targetPriority &&
        (!alias.compatibleOnly ||
          (!!targetMessage && replacementContentsAreCompatible(message, targetMessage)))
    )
    if (candidate) registerExactAlias(candidate.id, alias.targetId)
  }

  return {
    baseline: canonicalizeTranscriptMessages(baseline, exactAliases, prefixAliases),
    incoming: canonicalizeTranscriptMessages(
      pending.map((entry) => entry.message),
      exactAliases,
      prefixAliases
    )
  }
}

function orderCompleteTranscriptSnapshot(
  baselineIds: readonly string[],
  mergedMessages: readonly Message[],
  incomingMessages: readonly Message[]
): Message[] {
  const mergedById = new Map(mergedMessages.map((message) => [message.id, message]))
  const incomingIds = new Set(incomingMessages.map((message) => message.id))
  const incomingCoversBaseline = baselineIds.every((id) => incomingIds.has(id))
  const emitted = new Set<string>()
  const ordered: Message[] = []
  const emit = (id: string): void => {
    if (emitted.has(id)) return
    const message = mergedById.get(id)
    if (!message) return
    emitted.add(id)
    ordered.push(message)
  }

  if (incomingCoversBaseline) {
    incomingMessages.forEach((message) => emit(message.id))
    mergedMessages.forEach((message) => emit(message.id))
    return orderMessagesByProviderOccurrence(ordered)
  }

  baselineIds.forEach(emit)
  const baselineIdSet = new Set(baselineIds)
  let incomingSegmentStartsNewTurn = false
  let previousIncomingPlacementId: string | undefined
  incomingMessages.forEach((message, incomingIndex) => {
    if (message.role === "user") incomingSegmentStartsNewTurn = !baselineIdSet.has(message.id)
    if (emitted.has(message.id)) {
      previousIncomingPlacementId = message.id
      return
    }
    const snapshotAnchorId = incomingMessages
      .slice(incomingIndex + 1)
      .find((candidate) => baselineIdSet.has(candidate.id))?.id
    const occurrence = getMessageProviderOccurrence(message)
    const providerOccurrenceAnchorId =
      snapshotAnchorId ||
      previousIncomingPlacementId ||
      incomingSegmentStartsNewTurn ||
      occurrence === undefined
        ? undefined
        : ordered.find(
            (candidate) =>
              candidate.role === message.role &&
              getMessageProviderSourceId(candidate) === getMessageProviderSourceId(message) &&
              (getMessageProviderOccurrence(candidate) ?? 0) > occurrence
          )?.id
    const nextAnchorId = snapshotAnchorId ?? providerOccurrenceAnchorId
    if (!nextAnchorId) {
      emit(message.id)
      previousIncomingPlacementId = message.id
      return
    }
    const nextAnchorIndex = ordered.findIndex((candidate) => candidate.id === nextAnchorId)
    const mergedMessage = mergedById.get(message.id)
    if (nextAnchorIndex < 0 || !mergedMessage) {
      emit(message.id)
      previousIncomingPlacementId = message.id
      return
    }
    emitted.add(message.id)
    ordered.splice(nextAnchorIndex, 0, mergedMessage)
    previousIncomingPlacementId = message.id
  })
  mergedMessages.forEach((message) => emit(message.id))
  return orderMessagesByProviderOccurrence(ordered)
}

export function upsertTranscriptMessages(
  messages: Message[],
  incoming: Message[],
  options: UpsertTranscriptMessagesOptions = {}
): Message[] {
  if (incoming.length === 0) return messages
  const next: Message[] = []
  const baselineIndexById = new Map<string, number>()
  for (const message of normalizeCompleteMessageIds(messages)) {
    const existingIndex = baselineIndexById.get(message.id)
    if (existingIndex === undefined) {
      baselineIndexById.set(message.id, next.length)
      next.push(message)
    } else {
      next[existingIndex] = mergeTranscriptMessage(next[existingIndex], message)
    }
  }

  // A task completion has a stable final id, while its content may already be
  // visible under the live assistant id. Rebase that one known row in place so
  // completion remains idempotent across stream resets and values replays. The
  // replacement marker is an input instruction and is consumed before storage.
  const prepared = prepareTranscriptReplacements(next, incoming)
  next.splice(0, next.length, ...prepared.baseline)
  const preparedIncoming = prepared.incoming
  const baselineIds = next.map((message) => message.id)
  const indexById = new Map(next.map((message, index) => [message.id, index]))
  const normalizedIncoming = options.completeSnapshot
    ? normalizeCompleteSnapshotMessageIds(next, preparedIncoming)
    : normalizeAppendedMessageIds(next, preparedIncoming)
  const resolvedIncoming: Message[] = []
  for (const message of normalizedIncoming) {
    resolvedIncoming.push(message)
    const existingIndex = indexById.get(message.id)
    if (existingIndex === undefined) {
      indexById.set(message.id, next.length)
      next.push(message)
      continue
    }
    next[existingIndex] = mergeTranscriptMessage(next[existingIndex], message)
  }
  const ordered = options.completeSnapshot
    ? orderCompleteTranscriptSnapshot(baselineIds, next, resolvedIncoming)
    : next
  return ordered
}

export function mergeSubagentTranscripts(
  current: Record<string, Message[]>,
  subagentId: string,
  messages: Message[],
  options: UpsertTranscriptMessagesOptions = {}
): Record<string, Message[]> {
  return {
    ...current,
    [subagentId]: upsertTranscriptMessages(current[subagentId] ?? [], messages, options)
  }
}

function revivePersistedDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  return new Date()
}

function revivePersistedSubagentMessage(value: unknown): Message | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === "string" ? value.id : ""
  const role = typeof value.role === "string" ? value.role : ""
  if (!id || !["user", "assistant", "system", "tool"].includes(role)) return null
  const rawContent = value.content
  const content: Message["content"] =
    typeof rawContent === "string" || Array.isArray(rawContent) ? rawContent : ""
  const providerSourceId =
    typeof value.provider_source_id === "string" ? value.provider_source_id.trim() : ""
  const providerOccurrence =
    typeof value.provider_occurrence === "number" &&
    Number.isInteger(value.provider_occurrence) &&
    value.provider_occurrence > 0
      ? value.provider_occurrence
      : undefined
  const contentPriority =
    typeof value.content_priority === "number" && Number.isFinite(value.content_priority)
      ? value.content_priority
      : undefined
  const contentIsProjection = value.content_is_projection === true
  const contentFullLength =
    typeof value.content_full_length === "number" &&
    Number.isSafeInteger(value.content_full_length) &&
    value.content_full_length >= 0
      ? value.content_full_length
      : undefined
  const contentRef = isSubagentTranscriptBlobRef(value.content_ref, "content")
    ? value.content_ref
    : undefined
  const reasoningRef = isSubagentTranscriptBlobRef(value.reasoning_ref, "reasoning")
    ? value.reasoning_ref
    : undefined
  const toolCallsRef = isSubagentTranscriptBlobRef(value.tool_calls_ref, "tool_calls")
    ? value.tool_calls_ref
    : undefined
  const replacedMessageIds = Array.isArray(value.replaced_message_ids)
    ? mergeTranscriptReplacementAliases(
        undefined,
        value.replaced_message_ids.filter(
          (alias): alias is string => typeof alias === "string"
        )
      )
    : undefined
  const replacedMessageIdPrefixes = Array.isArray(value.replaced_message_id_prefixes)
    ? mergeTranscriptReplacementAliases(
        undefined,
        value.replaced_message_id_prefixes.filter(
          (alias): alias is string => typeof alias === "string"
        )
      )
    : undefined
  const compatibleReplacedMessageIdPrefixes = Array.isArray(
    value.compatible_replaced_message_id_prefixes
  )
    ? mergeTranscriptReplacementAliases(
        undefined,
        value.compatible_replaced_message_id_prefixes.filter(
          (alias): alias is string => typeof alias === "string"
        )
      )
    : undefined
  return {
    id,
    role: role as Message["role"],
    content,
    ...(providerSourceId && { provider_source_id: providerSourceId }),
    ...(providerOccurrence !== undefined && { provider_occurrence: providerOccurrence }),
    ...(contentPriority !== undefined && { content_priority: contentPriority }),
    ...(contentIsProjection && { content_is_projection: true }),
    ...(contentFullLength !== undefined && { content_full_length: contentFullLength }),
    ...(contentRef && { content_ref: contentRef }),
    ...(typeof value.reasoning === "string" && { reasoning: value.reasoning }),
    ...(value.reasoning_is_projection === true && { reasoning_is_projection: true }),
    ...(typeof value.reasoning_full_length === "number" &&
      Number.isSafeInteger(value.reasoning_full_length) &&
      value.reasoning_full_length >= 0 && {
        reasoning_full_length: value.reasoning_full_length
      }),
    ...(reasoningRef && { reasoning_ref: reasoningRef }),
    ...(replacedMessageIds && { replaced_message_ids: replacedMessageIds }),
    ...(replacedMessageIdPrefixes && {
      replaced_message_id_prefixes: replacedMessageIdPrefixes
    }),
    ...(compatibleReplacedMessageIdPrefixes && {
      compatible_replaced_message_id_prefixes: compatibleReplacedMessageIdPrefixes
    }),
    ...(typeof value.subagent_tool_call_id === "string" && {
      subagent_tool_call_id: value.subagent_tool_call_id
    }),
    ...(typeof value.subagent_invocation_scope === "string" && {
      subagent_invocation_scope: value.subagent_invocation_scope
    }),
    ...(typeof value.subagent_prompt_fingerprint === "string" && {
      subagent_prompt_fingerprint: value.subagent_prompt_fingerprint
    }),
    ...(typeof value.subagent_content_fingerprint === "string" && {
      subagent_content_fingerprint: value.subagent_content_fingerprint
    }),
    ...(typeof value.subagent_reasoning_fingerprint === "string" && {
      subagent_reasoning_fingerprint: value.subagent_reasoning_fingerprint
    }),
    ...(value.subagent_startup_projection === true && { subagent_startup_projection: true }),
    ...(value.subagent_startup_tool_calls_projection === true && {
      subagent_startup_tool_calls_projection: true
    }),
    ...(typeof value.subagent_name === "string" && {
      subagent_name: value.subagent_name
    }),
    ...(typeof value.subagent_description === "string" && {
      subagent_description: value.subagent_description
    }),
    ...(typeof value.subagent_type === "string" && {
      subagent_type: value.subagent_type
    }),
    ...(Array.isArray(value.tool_calls) && {
      tool_calls: value.tool_calls as Message["tool_calls"]
    }),
    ...(toolCallsRef && { tool_calls_ref: toolCallsRef }),
    ...(typeof value.tool_call_id === "string" && { tool_call_id: value.tool_call_id }),
    ...(typeof value.name === "string" && { name: value.name }),
    ...(typeof value.status === "string" && { status: value.status }),
    ...(typeof value.is_error === "boolean" && { is_error: value.is_error }),
    created_at: revivePersistedDate(value.created_at),
    ...(value.start_at !== undefined && { start_at: revivePersistedDate(value.start_at) }),
    ...(value.end_at !== undefined && { end_at: revivePersistedDate(value.end_at) })
  }
}

export function getSubagentTranscriptsFromThreadValues(
  threadValues?: Record<string, unknown>
): Record<string, Message[]> {
  const value = threadValues?.[SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY]
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([subagentId, messages]) => [
        subagentId,
        // Route restored messages through the same identity/replacement pipeline
        // as live writes without discarding historical content.
        Array.isArray(messages)
          ? upsertTranscriptMessages(
              [],
              messages
                .map(revivePersistedSubagentMessage)
                .filter((message): message is Message => message !== null),
              { completeSnapshot: true }
            )
          : []
      ])
      .filter(([, messages]) => messages.length > 0)
  )
}

function serializeSubagentMessage(message: Message): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    ...message,
    created_at: message.created_at.toISOString(),
    ...(message.start_at && { start_at: message.start_at.toISOString() }),
    ...(message.end_at && { end_at: message.end_at.toISOString() })
  }
  if (isSubagentTranscriptBlobRef(message.content_ref, "content")) {
    if (typeof message.content === "string") {
      serialized.content = projectSubagentTranscriptContentForStorage(message.content)
      serialized.content_full_length =
        message.content_is_projection === true &&
        typeof message.content_full_length === "number" &&
        Number.isSafeInteger(message.content_full_length) &&
        message.content_full_length >= message.content.length
          ? message.content_full_length
          : message.content.length
    } else {
      serialized.content = []
    }
    serialized.content_is_projection = true
  }
  if (
    isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning") &&
    typeof message.reasoning === "string"
  ) {
    serialized.reasoning = projectSubagentTranscriptContentForStorage(message.reasoning)
    serialized.reasoning_full_length =
      message.reasoning_is_projection === true &&
      typeof message.reasoning_full_length === "number" &&
      Number.isSafeInteger(message.reasoning_full_length) &&
      message.reasoning_full_length >= message.reasoning.length
        ? message.reasoning_full_length
        : message.reasoning.length
    serialized.reasoning_is_projection = true
  }
  if (isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")) {
    delete serialized.tool_calls
  }
  return serialized
}

export function serializeSubagentTranscripts(
  transcripts: Record<string, Message[]>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(transcripts).map(([subagentId, messages]) => [
      subagentId,
      messages.map(serializeSubagentMessage)
    ])
  )
}

function transcriptFieldEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

/**
 * Attach refs returned by the main process without replacing hydrated display
 * fields. A response may race a newer live update, so each field is attached
 * only while the value that was sent is still current.
 */
export function applyPersistedSubagentTranscriptRefs(
  current: Record<string, Message[]>,
  sent: Record<string, Message[]>,
  persistedManifests: Record<string, unknown>
): Record<string, Message[]> {
  let changed = false
  const next = { ...current }
  for (const [subagentId, sentMessages] of Object.entries(sent)) {
    const currentMessages = current[subagentId]
    const rawPersistedMessages = persistedManifests[subagentId]
    if (!currentMessages || !Array.isArray(rawPersistedMessages)) continue
    const sentById = new Map(sentMessages.map((message) => [message.id, message]))
    const persistedById = new Map(
      rawPersistedMessages.flatMap((value) =>
        isRecord(value) && typeof value.id === "string" ? [[value.id, value] as const] : []
      )
    )
    let bucketChanged = false
    const updatedMessages = currentMessages.map((message) => {
      const sentMessage = sentById.get(message.id)
      const persisted = persistedById.get(message.id)
      if (!sentMessage || !persisted) return message
      const contentRef = isSubagentTranscriptBlobRef(persisted.content_ref, "content")
        ? persisted.content_ref
        : undefined
      const reasoningRef = isSubagentTranscriptBlobRef(persisted.reasoning_ref, "reasoning")
        ? persisted.reasoning_ref
        : undefined
      const toolCallsRef = isSubagentTranscriptBlobRef(
        persisted.tool_calls_ref,
        "tool_calls"
      )
        ? persisted.tool_calls_ref
        : undefined
      const canAttachContentRef =
        !!contentRef && transcriptFieldEquals(message.content, sentMessage.content)
      const canAttachReasoningRef =
        !!reasoningRef && transcriptFieldEquals(message.reasoning, sentMessage.reasoning)
      const canAttachToolCallsRef =
        !!toolCallsRef && transcriptFieldEquals(message.tool_calls, sentMessage.tool_calls)
      if (
        (!canAttachContentRef || message.content_ref?.sha256 === contentRef.sha256) &&
        (!canAttachReasoningRef || message.reasoning_ref?.sha256 === reasoningRef.sha256) &&
        (!canAttachToolCallsRef || message.tool_calls_ref?.sha256 === toolCallsRef.sha256)
      ) {
        return message
      }
      bucketChanged = true
      return {
        ...message,
        ...(canAttachContentRef && { content_ref: contentRef }),
        ...(canAttachReasoningRef && { reasoning_ref: reasoningRef }),
        ...(canAttachToolCallsRef && { tool_calls_ref: toolCallsRef })
      }
    })
    if (bucketChanged) {
      next[subagentId] = updatedMessages
      changed = true
    }
  }
  return changed ? next : current
}
