import type { Message } from "../types"

export const STREAM_PANEL_MESSAGE_WINDOW_SIZE = 240
export const STREAM_PANEL_MESSAGE_WINDOW_SHIFT = 80
const STREAM_PANEL_TAIL_PROJECTION_SIZE = 32

export interface StreamPanelMessageWindow<T> {
  start: number
  end: number
  messages: T[]
}

export interface StreamPanelMessageProjection {
  messages: Message[]
  contentVersion: number
  structureVersion: number
}

function tailStructureKey(messages: readonly Message[]): string {
  const start = Math.max(0, messages.length - STREAM_PANEL_TAIL_PROJECTION_SIZE)
  const parts = [String(messages.length)]
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index]
    parts.push(
      `${message.id}\u0000${message.role}\u0000${message.tool_call_id ?? ""}\u0000${
        message.provider_occurrence ?? ""
      }`
    )
  }
  return parts.join("\u0001")
}

/**
 * Stabilizes a cumulative stream array. If its bounded tail keeps the same
 * identities, only those slots are refreshed and the historical prefix is not
 * copied or inspected.
 */
export function createStreamPanelMessageProjector(): (
  incoming: readonly Message[],
  allowTailFastPath?: boolean
) => StreamPanelMessageProjection {
  let previousStructureKey = ""
  let previousIncoming: readonly Message[] | null = null
  let messages: Message[] = []
  let contentVersion = 0
  let structureVersion = 0
  let lastProjectionUsedTailFastPath = false

  return (incoming, allowTailFastPath = true) => {
    const incomingChanged = incoming !== previousIncoming
    const nextStructureKey = tailStructureKey(incoming)
    if (
      nextStructureKey !== previousStructureKey ||
      (!allowTailFastPath && (incomingChanged || lastProjectionUsedTailFastPath))
    ) {
      messages = incoming.slice()
      previousStructureKey = nextStructureKey
      previousIncoming = incoming
      contentVersion += 1
      structureVersion += 1
      lastProjectionUsedTailFastPath = false
      return { messages, contentVersion, structureVersion }
    }

    let changed = false
    const start = Math.max(0, incoming.length - STREAM_PANEL_TAIL_PROJECTION_SIZE)
    for (let index = start; index < incoming.length; index += 1) {
      const message = incoming[index]
      if (messages[index] === message) continue
      messages[index] = message
      changed = true
    }
    if (changed) contentVersion += 1
    if (allowTailFastPath && incomingChanged) lastProjectionUsedTailFastPath = true
    previousIncoming = incoming
    return { messages, contentVersion, structureVersion }
  }
}

export function buildStreamPanelMessageWindow<T>(
  messages: readonly T[],
  requestedEnd: number | null
): StreamPanelMessageWindow<T> {
  const end =
    requestedEnd === null
      ? messages.length
      : Math.max(0, Math.min(Math.floor(requestedEnd), messages.length))
  const start = Math.max(0, end - STREAM_PANEL_MESSAGE_WINDOW_SIZE)
  return { start, end, messages: messages.slice(start, end) }
}

export function shiftStreamPanelMessageWindowEnd(
  currentEnd: number,
  messageCount: number,
  direction: "older" | "newer"
): number | null {
  if (messageCount <= STREAM_PANEL_MESSAGE_WINDOW_SIZE) return null
  if (direction === "older") {
    return Math.max(
      STREAM_PANEL_MESSAGE_WINDOW_SIZE,
      currentEnd - STREAM_PANEL_MESSAGE_WINDOW_SHIFT
    )
  }
  const nextEnd = Math.min(messageCount, currentEnd + STREAM_PANEL_MESSAGE_WINDOW_SHIFT)
  return nextEnd >= messageCount ? null : nextEnd
}
