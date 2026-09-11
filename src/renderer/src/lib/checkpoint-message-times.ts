import { getMessageProviderOccurrenceIdentity } from "../../../shared/message-role-collision"

export type CheckpointMessageTimeMap = Record<string, { start_at?: string; end_at?: string }>
export type CheckpointMessageTimeEntry = CheckpointMessageTimeMap[string] & { id: string }
export type CheckpointVisibleMessageTimeTarget = {
  id: string
  role: string
  provider_source_id?: string
  provider_occurrence?: number
  created_at: Date
  start_at?: Date
  end_at?: Date
}
export type CheckpointPersistedMessageTimeTarget = {
  id: string
  role?: string
  provider_source_id?: string
  provider_occurrence?: number
  created_at: Date
  start_at?: Date
}

const toDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : undefined
}

export function restoreRawCheckpointMessageTime(params: {
  messageId: string
  fallbackTime: Date
  isInternalGoalPrompt: boolean
  internalGoalPromptIndex: number
  persistedMessageTimes: CheckpointMessageTimeMap
  persistedInternalGoalMessageTimes: CheckpointMessageTimeMap
  persistedInternalGoalMessageTimeOrder: CheckpointMessageTimeEntry[]
}): { startAt: Date; endAt: Date } {
  const {
    messageId,
    fallbackTime,
    isInternalGoalPrompt,
    internalGoalPromptIndex,
    persistedMessageTimes,
    persistedInternalGoalMessageTimes,
    persistedInternalGoalMessageTimeOrder
  } = params

  const persistedTime = isInternalGoalPrompt
    ? (persistedInternalGoalMessageTimes[messageId] ??
      persistedInternalGoalMessageTimeOrder[internalGoalPromptIndex])
    : persistedMessageTimes[messageId]
  const startAt = toDate(persistedTime?.start_at) ?? fallbackTime
  const endAt = toDate(persistedTime?.end_at) ?? startAt
  return { startAt, endAt }
}

const offsetDate = (date: Date, offsetMs: number): Date => new Date(date.getTime() + offsetMs)

const validDate = (date: Date | undefined): Date | undefined => {
  return date && Number.isFinite(date.getTime()) ? date : undefined
}

export function latestPersistedCheckpointMessageAt(
  visibleCheckpointMessages: readonly {
    id: string
    role?: string
    renderId?: string
    provider_source_id?: string
    provider_occurrence?: number
  }[],
  persistedMessages: readonly CheckpointPersistedMessageTimeTarget[]
): Date | undefined {
  const checkpointMessageIds = new Set(
    visibleCheckpointMessages
      .filter((message) => !message.role)
      .map((message) => message.renderId || message.id)
      .filter(Boolean)
  )
  const checkpointMessageIdentities = new Set(
    visibleCheckpointMessages
      .filter((message) => Boolean(message.role))
      .map((message) =>
        getMessageProviderOccurrenceIdentity({ ...message, id: message.renderId || message.id })
      )
  )
  if (checkpointMessageIds.size === 0 && checkpointMessageIdentities.size === 0) return undefined

  let latest: Date | undefined
  for (const message of persistedMessages) {
    const matchesCheckpoint =
      checkpointMessageIds.has(message.id) ||
      (Boolean(message.role) &&
        checkpointMessageIdentities.has(getMessageProviderOccurrenceIdentity(message)))
    if (!matchesCheckpoint) continue
    const candidate = validDate(message.start_at) ?? validDate(message.created_at)
    if (candidate && (!latest || candidate > latest)) latest = candidate
  }
  return latest
}

export function restoreVisibleCheckpointMessageTimes<T extends CheckpointVisibleMessageTimeTarget>(
  messages: T[],
  persistedMessageTimes: CheckpointMessageTimeMap,
  persistedMessageTimeOrder: CheckpointMessageTimeEntry[],
  persistedMessages: readonly CheckpointPersistedMessageTimeTarget[] = []
): T[] {
  const persistedTimeByIdentity = new Map<string, CheckpointMessageTimeMap[string]>()
  const persistedRoleByRenderId = new Map<string, string>()
  for (const persistedMessage of persistedMessages) {
    if (!persistedMessage.role) continue
    persistedRoleByRenderId.set(persistedMessage.id, persistedMessage.role)
    const persistedTime = persistedMessageTimes[persistedMessage.id]
    if (persistedTime) {
      persistedTimeByIdentity.set(
        getMessageProviderOccurrenceIdentity(persistedMessage),
        persistedTime
      )
    }
  }

  const idRestored = messages.map((message, index) => {
    const identityTime = persistedTimeByIdentity.get(
      getMessageProviderOccurrenceIdentity(message)
    )
    const renderIdOwnerRole = persistedRoleByRenderId.get(message.id)
    const persistedTime =
      identityTime ??
      (!renderIdOwnerRole || renderIdOwnerRole === message.role
        ? persistedMessageTimes[message.id]
        : undefined)
    const startAt = toDate(persistedTime?.start_at)
    const endAt = toDate(persistedTime?.end_at) ?? startAt
    return {
      index,
      message,
      startAt,
      endAt
    }
  })

  const hasAnyIdMatch = idRestored.some((entry) => entry.startAt)

  return idRestored.map((entry) => {
    if (entry.startAt) {
      return {
        ...entry.message,
        created_at: entry.startAt,
        start_at: entry.startAt,
        end_at: entry.endAt ?? entry.startAt
      }
    }

    let previousKnown: (typeof idRestored)[number] | undefined
    for (let i = entry.index - 1; i >= 0; i -= 1) {
      if (idRestored[i].startAt) {
        previousKnown = idRestored[i]
        break
      }
    }

    let nextKnown: (typeof idRestored)[number] | undefined
    for (let i = entry.index + 1; i < idRestored.length; i += 1) {
      if (idRestored[i].startAt) {
        nextKnown = idRestored[i]
        break
      }
    }

    // User ids can change between LangGraph checkpoint serialization and the
    // UI-side message time store. A plain index fallback is unsafe here because
    // /goal status events are persisted in the UI transcript but are not present
    // in the LangGraph checkpoint, shifting every later index. For unmatched
    // users, anchor them just before their next known response instead.
    let startAt: Date | undefined
    let endAt: Date | undefined
    let inferredStartAt = false
    if (entry.message.role === "user" && nextKnown?.startAt) {
      startAt = offsetDate(nextKnown.startAt, -1000)
      inferredStartAt = true
    } else if (previousKnown?.startAt) {
      startAt = offsetDate(previousKnown.startAt, (entry.index - previousKnown.index) * 1000)
      inferredStartAt = true
    } else if (nextKnown?.startAt) {
      startAt = offsetDate(nextKnown.startAt, -(nextKnown.index - entry.index) * 1000)
      inferredStartAt = true
    }

    if (!startAt && !hasAnyIdMatch) {
      const orderTime = persistedMessageTimeOrder[entry.index]
      startAt = toDate(orderTime?.start_at)
      const orderEndAt = toDate(orderTime?.end_at)
      if (startAt) {
        inferredStartAt = true
        endAt = orderEndAt && orderEndAt >= startAt ? orderEndAt : startAt
      }
    }

    startAt = startAt ?? entry.message.start_at ?? entry.message.created_at
    if (!endAt) {
      endAt =
        !inferredStartAt && entry.message.end_at && entry.message.end_at > startAt
          ? entry.message.end_at
          : startAt
    }

    return {
      ...entry.message,
      created_at: startAt,
      start_at: startAt,
      end_at: endAt
    }
  })
}
