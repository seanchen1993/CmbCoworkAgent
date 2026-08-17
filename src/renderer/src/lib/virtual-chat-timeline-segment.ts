import type { Message } from "../types"

export interface VirtualChatTimelineItem {
  id: string
  message?: Message
  messageIndex?: number
  previousMessage?: Message | null
}

export interface VirtualChatTimelineSegment {
  items: VirtualChatTimelineItem[]
  messageRowIndexById: Map<string, number>
  lastVisibleMessage: Message | null
  lastVisibleMessageIndex: number
}

interface BuildVirtualChatTimelineSegmentOptions {
  messageIndexOffset: number
  rowIndexOffset: number
  previousVisibleMessage: Message | null
  isVisible: (message: Message) => boolean
}

export function buildVirtualChatTimelineSegment(
  messages: readonly Message[],
  {
    messageIndexOffset,
    rowIndexOffset,
    previousVisibleMessage,
    isVisible
  }: BuildVirtualChatTimelineSegmentOptions
): VirtualChatTimelineSegment {
  const items: VirtualChatTimelineItem[] = []
  const messageRowIndexById = new Map<string, number>()
  let lastVisibleMessage = previousVisibleMessage
  let lastVisibleMessageIndex = -1

  messages.forEach((message, messageIndex) => {
    if (!isVisible(message)) return

    const absoluteMessageIndex = messageIndexOffset + messageIndex
    messageRowIndexById.set(message.id, rowIndexOffset + items.length)
    items.push({
      id: `message:${message.role}:${message.id}`,
      message,
      messageIndex: absoluteMessageIndex,
      previousMessage: lastVisibleMessage
    })
    lastVisibleMessage = message
    lastVisibleMessageIndex = absoluteMessageIndex
  })

  return {
    items,
    messageRowIndexById,
    lastVisibleMessage,
    lastVisibleMessageIndex
  }
}
