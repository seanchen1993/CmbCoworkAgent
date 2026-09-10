export interface ChatMessageWindow {
  startIndex: number
  endIndex: number
}

export const CHAT_MESSAGE_WINDOW_SIZE = 240
export const CHAT_MESSAGE_WINDOW_SHIFT = 80

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function createTailChatMessageWindow(
  messageCount: number,
  windowSize = CHAT_MESSAGE_WINDOW_SIZE
): ChatMessageWindow {
  const endIndex = Math.max(0, messageCount)
  return {
    startIndex: Math.max(0, endIndex - windowSize),
    endIndex
  }
}

/** Keep the former first row visible after an older durable page is prepended. */
export function createPrependAnchoredChatMessageWindow(
  anchorIndex: number,
  messageCount: number,
  windowSize = CHAT_MESSAGE_WINDOW_SIZE
): ChatMessageWindow {
  const endIndex = clamp(Math.floor(anchorIndex) + 1, 0, Math.max(0, messageCount))
  return {
    startIndex: Math.max(0, endIndex - windowSize),
    endIndex
  }
}

export function reconcileChatMessageWindow(
  previous: ChatMessageWindow,
  messageCount: number,
  followTail: boolean,
  windowSize = CHAT_MESSAGE_WINDOW_SIZE
): ChatMessageWindow {
  if (followTail) {
    return createTailChatMessageWindow(messageCount, windowSize)
  }

  const endIndex = clamp(previous.endIndex, 0, messageCount)
  const startIndex = clamp(previous.startIndex, 0, endIndex)
  if (endIndex - startIndex <= windowSize) return { startIndex, endIndex }
  return { startIndex: endIndex - windowSize, endIndex }
}

export function shiftChatMessageWindow(
  previous: ChatMessageWindow,
  messageCount: number,
  direction: "older" | "newer",
  windowSize = CHAT_MESSAGE_WINDOW_SIZE,
  shiftSize = CHAT_MESSAGE_WINDOW_SHIFT
): ChatMessageWindow {
  if (messageCount <= windowSize) return { startIndex: 0, endIndex: messageCount }

  if (direction === "older") {
    const startIndex = Math.max(0, previous.startIndex - shiftSize)
    return { startIndex, endIndex: Math.min(messageCount, startIndex + windowSize) }
  }

  const endIndex = Math.min(messageCount, previous.endIndex + shiftSize)
  return { startIndex: Math.max(0, endIndex - windowSize), endIndex }
}

export function revealChatMessageIndex(
  previous: ChatMessageWindow,
  messageIndex: number,
  messageCount: number,
  windowSize = CHAT_MESSAGE_WINDOW_SIZE
): ChatMessageWindow {
  if (
    messageIndex >= previous.startIndex &&
    messageIndex < previous.endIndex &&
    previous.endIndex <= messageCount
  ) {
    return previous
  }

  const safeIndex = clamp(messageIndex, 0, Math.max(0, messageCount - 1))
  const halfWindow = Math.floor(windowSize / 2)
  const startIndex = clamp(safeIndex - halfWindow, 0, Math.max(0, messageCount - windowSize))
  return { startIndex, endIndex: Math.min(messageCount, startIndex + windowSize) }
}

export function isTailChatMessageWindow(
  window: ChatMessageWindow,
  messageCount: number
): boolean {
  return window.endIndex >= messageCount
}
