export type CheckpointMessageTimeMap = Record<string, { start_at?: string; end_at?: string }>
export type CheckpointMessageTimeEntry = CheckpointMessageTimeMap[string] & { id: string }

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
