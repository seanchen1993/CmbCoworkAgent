function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

export function isChatMessageIndexVisible(
  index: number,
  stableVisibleIndexes: ReadonlySet<number>,
  dynamicVisibilityByIndex: ReadonlyMap<number, boolean>
): boolean {
  return dynamicVisibilityByIndex.get(index) ?? stableVisibleIndexes.has(index)
}

export function findPreviousVisibleChatMessageIndex(
  beforeIndex: number,
  orderedStableVisibleIndexes: readonly number[],
  dynamicVisibilityByIndex: ReadonlyMap<number, boolean>,
  orderedDynamicVisibleIndexes: readonly number[]
): number | null {
  let stablePosition = lowerBound(orderedStableVisibleIndexes, beforeIndex) - 1
  let stableCandidate: number | null = null
  while (stablePosition >= 0) {
    const candidate = orderedStableVisibleIndexes[stablePosition]
    if (dynamicVisibilityByIndex.get(candidate) !== false) {
      stableCandidate = candidate
      break
    }
    stablePosition -= 1
  }

  const dynamicPosition = lowerBound(orderedDynamicVisibleIndexes, beforeIndex) - 1
  const dynamicCandidate =
    dynamicPosition >= 0 ? orderedDynamicVisibleIndexes[dynamicPosition] : null

  if (stableCandidate === null) return dynamicCandidate
  if (dynamicCandidate === null) return stableCandidate
  return Math.max(stableCandidate, dynamicCandidate)
}

export function findNextVisibleChatMessageIndex(
  fromIndex: number,
  orderedStableVisibleIndexes: readonly number[],
  dynamicVisibilityByIndex: ReadonlyMap<number, boolean>,
  orderedDynamicVisibleIndexes: readonly number[]
): number | null {
  let stablePosition = lowerBound(orderedStableVisibleIndexes, fromIndex)
  let stableCandidate: number | null = null
  while (stablePosition < orderedStableVisibleIndexes.length) {
    const candidate = orderedStableVisibleIndexes[stablePosition]
    if (dynamicVisibilityByIndex.get(candidate) !== false) {
      stableCandidate = candidate
      break
    }
    stablePosition += 1
  }

  const dynamicPosition = lowerBound(orderedDynamicVisibleIndexes, fromIndex)
  const dynamicCandidate =
    dynamicPosition < orderedDynamicVisibleIndexes.length
      ? orderedDynamicVisibleIndexes[dynamicPosition]
      : null

  if (stableCandidate === null) return dynamicCandidate
  if (dynamicCandidate === null) return stableCandidate
  return Math.min(stableCandidate, dynamicCandidate)
}

export interface ChatMessageWindowRenderRow<T extends { role: string }> {
  message: T
  index: number
  previousMessage: T | null
  isLastMessage: boolean
  hasUserAfterHead: boolean
  showAssistantMeta: boolean
}

/** Derives render metadata from the bounded window plus its visible boundaries. */
export function deriveChatMessageWindowRows<T extends { role: string }>(
  messages: readonly T[],
  startIndex: number,
  endIndex: number,
  orderedStableVisibleIndexes: readonly number[],
  stableVisibleIndexes: ReadonlySet<number>,
  dynamicVisibilityByIndex: ReadonlyMap<number, boolean>,
  lastUserMessageIndex: number,
  orderedDynamicVisibleIndexes: readonly number[]
): ChatMessageWindowRenderRow<T>[] {
  const lastVisibleMessageIndex = findPreviousVisibleChatMessageIndex(
    messages.length,
    orderedStableVisibleIndexes,
    dynamicVisibilityByIndex,
    orderedDynamicVisibleIndexes
  )
  const previousVisibleIndex = findPreviousVisibleChatMessageIndex(
    startIndex,
    orderedStableVisibleIndexes,
    dynamicVisibilityByIndex,
    orderedDynamicVisibleIndexes
  )
  let previousVisibleMessage =
    previousVisibleIndex === null ? null : messages[previousVisibleIndex] ?? null
  const rows: ChatMessageWindowRenderRow<T>[] = []

  for (let index = startIndex; index < endIndex; index += 1) {
    if (!isChatMessageIndexVisible(index, stableVisibleIndexes, dynamicVisibilityByIndex)) {
      continue
    }
    const message = messages[index]
    if (!message) continue
    rows.push({
      message,
      index,
      previousMessage: previousVisibleMessage,
      isLastMessage: index === lastVisibleMessageIndex,
      hasUserAfterHead: index < lastUserMessageIndex,
      showAssistantMeta: true
    })
    previousVisibleMessage = message
  }

  return rows.map((row, rowIndex) => {
    const nextWindowRow = rows[rowIndex + 1]
    const nextVisibleIndex = nextWindowRow
      ? null
      : findNextVisibleChatMessageIndex(
          row.index + 1,
          orderedStableVisibleIndexes,
          dynamicVisibilityByIndex,
          orderedDynamicVisibleIndexes
        )
    const nextVisibleRole = nextWindowRow
      ? nextWindowRow.message.role
      : nextVisibleIndex === null
        ? null
        : messages[nextVisibleIndex]?.role ?? null
    return {
      ...row,
      showAssistantMeta:
        row.message.role !== "assistant" ||
        nextVisibleRole === null ||
        nextVisibleRole !== "assistant"
    }
  })
}
