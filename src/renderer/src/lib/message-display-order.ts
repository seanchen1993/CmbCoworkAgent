interface DisplayOrderMessage {
  id: string
  role?: string
  type?: string
  tool_calls?: unknown
  tool_call_id?: unknown
}

function hasRole(message: DisplayOrderMessage, role: string, fallbackType: string = role): boolean {
  if (typeof message.role === "string") return message.role === role
  return message.type === fallbackType
}

function isUserMessage(message: DisplayOrderMessage): boolean {
  return hasRole(message, "user", "human") || hasRole(message, "user")
}

function isAssistantMessage(message: DisplayOrderMessage): boolean {
  return hasRole(message, "assistant", "ai") || hasRole(message, "assistant")
}

function isToolMessage(message: DisplayOrderMessage): boolean {
  return hasRole(message, "tool")
}

function readToolCallIds(message: DisplayOrderMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((toolCall) => {
    if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return []
    const id = (toolCall as { id?: unknown }).id
    return typeof id === "string" && id ? [id] : []
  })
}

function readToolMessageCallId(message: DisplayOrderMessage): string | undefined {
  if (!isToolMessage(message)) return undefined
  return typeof message.tool_call_id === "string" && message.tool_call_id
    ? message.tool_call_id
    : undefined
}

function hasDuplicateMessageIds(messages: ReadonlyArray<DisplayOrderMessage>): boolean {
  const ids = new Set<string>()
  for (const message of messages) {
    if (ids.has(message.id)) return true
    ids.add(message.id)
  }
  return false
}

function reconcileHintedSlots<T extends DisplayOrderMessage>(
  messages: T[],
  hintRankById: ReadonlyMap<string, number>
): T[] {
  if (messages.length < 2 || hintRankById.size < 2) return messages

  const hintedMessages = messages.filter((message) => hintRankById.has(message.id))
  if (hintedMessages.length < 2) return messages
  hintedMessages.sort((left, right) => hintRankById.get(left.id)! - hintRankById.get(right.id)!)

  const hintedSlots: number[] = []
  for (let index = 0; index < messages.length; index += 1) {
    if (hintRankById.has(messages[index].id)) hintedSlots.push(index)
  }
  if (hintedSlots.length !== hintedMessages.length) return messages

  const reconciled = [...messages]
  for (let index = 0; index < hintedSlots.length; index += 1) {
    reconciled[hintedSlots[index]] = hintedMessages[index]
  }
  return reconciled
}

function reconcileHintedSlotsWithinTurns<T extends DisplayOrderMessage>(
  messages: T[],
  hintRankById: ReadonlyMap<string, number>
): T[] {
  const reconciled: T[] = []
  let segment: T[] = []

  const flushSegment = (): void => {
    if (segment.length > 0) {
      reconciled.push(...reconcileHintedSlots(segment, hintRankById))
      segment = []
    }
  }

  for (const message of messages) {
    if (isUserMessage(message)) {
      flushSegment()
      reconciled.push(message)
      continue
    }
    segment.push(message)
  }
  flushSegment()
  return reconciled
}

interface ToolCallGroups<T extends DisplayOrderMessage> {
  toolsByHeadId: Map<string, T[]>
  matchedToolMessageIds: Set<string>
}

function collectToolCallGroups<T extends DisplayOrderMessage>(messages: T[]): ToolCallGroups<T> {
  const toolsByHeadId = new Map<string, T[]>()
  const matchedToolMessageIds = new Set<string>()
  let segment: T[] = []

  const collectSegment = (): void => {
    if (segment.length < 2) {
      segment = []
      return
    }

    // A repeated tool-call id in one turn is ambiguous. Do not guess which
    // assistant owns its result; leaving the original order is safer.
    const ownerByCallId = new Map<string, T | null>()
    for (const message of segment) {
      if (!isAssistantMessage(message)) continue
      for (const callId of readToolCallIds(message)) {
        const existingOwner = ownerByCallId.get(callId)
        if (existingOwner === undefined) {
          ownerByCallId.set(callId, message)
        } else if (existingOwner?.id !== message.id) {
          ownerByCallId.set(callId, null)
        }
      }
    }

    for (const message of segment) {
      const callId = readToolMessageCallId(message)
      if (!callId) continue
      const owner = ownerByCallId.get(callId)
      if (!owner) continue
      const tools = toolsByHeadId.get(owner.id) ?? []
      tools.push(message)
      toolsByHeadId.set(owner.id, tools)
      matchedToolMessageIds.add(message.id)
    }
    segment = []
  }

  for (const message of messages) {
    if (isUserMessage(message)) {
      collectSegment()
      continue
    }
    segment.push(message)
  }
  collectSegment()

  return { toolsByHeadId, matchedToolMessageIds }
}

function reconcileToolCallOrder<T extends DisplayOrderMessage>(
  messages: T[],
  orderedHintIds: readonly string[]
): T[] {
  // User bubbles are locally owned transcript boundaries and are intentionally
  // absent from ordinary values snapshots. Even if a provider includes them in
  // a hint, never let that secondary source move a turn boundary.
  const userMessageIds = new Set(
    messages.filter((message) => isUserMessage(message)).map((message) => message.id)
  )
  const stableHintIds = orderedHintIds.filter((id) => !userMessageIds.has(id))
  const stableHintRankById = new Map(stableHintIds.map((id, index) => [id, index]))
  const { toolsByHeadId, matchedToolMessageIds } = collectToolCallGroups(messages)
  if (matchedToolMessageIds.size === 0) {
    return reconcileHintedSlotsWithinTurns(messages, stableHintRankById)
  }

  // Remove matched tool results before assigning authoritative hint slots. Tool
  // results are invisible attachments to their assistant head, so allowing them
  // to consume slots makes a second reconciliation move snapshot-external
  // messages. Reconciling the structural messages first makes this operation
  // idempotent while preserving every non-tool anchor.
  const structuralMessages = messages.filter((message) => !matchedToolMessageIds.has(message.id))
  const reconciledStructuralMessages = reconcileHintedSlotsWithinTurns(
    structuralMessages,
    stableHintRankById
  )

  const reconciledToolsByHeadId = new Map<string, T[]>()
  for (const [headId, tools] of toolsByHeadId) {
    reconciledToolsByHeadId.set(headId, reconcileHintedSlots(tools, stableHintRankById))
  }

  const reconciled: T[] = []
  for (const message of reconciledStructuralMessages) {
    reconciled.push(message)
    reconciled.push(...(reconciledToolsByHeadId.get(message.id) ?? []))
  }
  return reconciled
}

export function reconcileMessageDisplayOrder<T extends DisplayOrderMessage>(
  messages: T[],
  orderHintMessages: ReadonlyArray<{ id?: string }> | undefined
): T[] {
  if (messages.length < 2 || !orderHintMessages?.length) return messages

  // A hint identifies messages only by id, so duplicate ids are inherently
  // ambiguous. Fail closed instead of dropping or merging distinct messages.
  if (hasDuplicateMessageIds(messages)) return messages

  const messageIds = new Set(messages.map((message) => message.id))
  const orderedHintIds: string[] = []
  const seenHintIds = new Set<string>()
  for (const hint of orderHintMessages) {
    const id = typeof hint.id === "string" ? hint.id : ""
    if (!id || seenHintIds.has(id) || !messageIds.has(id)) continue
    seenHintIds.add(id)
    orderedHintIds.push(id)
  }
  if (orderedHintIds.length < 2) return messages

  return reconcileToolCallOrder(messages, orderedHintIds)
}
