import type { Message } from "@/types"
import type { ChatMessageProjection } from "./chat-message-projection"

const padTimePart = (value: number): string => String(value).padStart(2, "0")

// Absolute local time needs no clock subscription or relative-date invalidation.
// Keep formatting cheap: this also runs when timing metadata is rebuilt for history.
export function formatMessageTimeLabel(time: number): string | null {
  const date = new Date(time)
  if (!Number.isFinite(date.getTime())) return null
  const day = `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}`
  return `${day} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`
}

function toDate(value: Date | string | number | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  if (value === undefined) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}

function toTime(value: Date | string | number | undefined): number | null {
  return toDate(value)?.getTime() ?? null
}

function getCreatedTime(message: Message): number | null {
  return toTime(message.created_at) ?? toTime(message.start_at) ?? toTime(message.end_at)
}

export function getAssistantStartTime(message: Message): number | null {
  if (message.role !== "assistant") return null
  return toTime(message.start_at) ?? getCreatedTime(message)
}

function getEndTime(message: Message): number | null {
  return toTime(message.end_at) ?? toTime(message.created_at) ?? toTime(message.start_at)
}

export function buildMessageBubbleTimingMeta(messages: Message[]): {
  assistantDurationMsById: Map<string, number>
  userSendTimeLabelById: Map<string, string>
} {
  const assistantDurationMsById = new Map<string, number>()
  const userSendTimeLabelById = new Map<string, string>()

  for (const message of messages) {
    if (message.role !== "user") continue
    const createdAt = getCreatedTime(message)
    if (createdAt === null) continue
    const label = formatMessageTimeLabel(createdAt)
    if (label) userSendTimeLabelById.set(message.id, label)
  }

  for (let userIndex = 0; userIndex < messages.length; userIndex += 1) {
    const userMessage = messages[userIndex]
    if (userMessage.role !== "user") continue

    const userCreatedAt = getCreatedTime(userMessage)
    if (userCreatedAt === null) continue

    let nextUserIndex = -1
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === "user") {
        nextUserIndex = index
        break
      }
    }

    const turnEndIndex = nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1
    if (turnEndIndex < userIndex) continue

    const turnEndTime = getEndTime(messages[turnEndIndex])
    if (turnEndTime === null) continue

    let firstAssistantId: string | null = null
    for (let index = userIndex + 1; index <= turnEndIndex; index += 1) {
      if (messages[index].role === "assistant") {
        firstAssistantId = messages[index].id
        break
      }
    }

    if (!firstAssistantId) continue
    assistantDurationMsById.set(firstAssistantId, Math.max(0, turnEndTime - userCreatedAt))
  }

  return { assistantDurationMsById, userSendTimeLabelById }
}

interface TimingTurn {
  userIndex: number
  endIndex: number
  assistantId: string | null
  userTime: number | null
  endTime: number | null
}

/** Historical turns remain stable while a streaming tail changes its body and end time.
 * All retained times are values, never mutable Date or Message references.
 */
export function createMessageBubbleTimingProjector() {
  let source: Message[] | undefined, structure = -1, content = -1
  let result: ReturnType<typeof buildMessageBubbleTimingMeta> | undefined
  let indices = new Map<string, number[]>()
  let byIndex: Array<TimingTurn | undefined> = []
  let userCandidates = new Map<string, TimingTurn[]>()
  let assistantCandidates = new Map<string, TimingTurn[]>()

  const rebuild = (projection: ChatMessageProjection) => {
    source = projection.messages; structure = projection.structureVersion
    result = buildMessageBubbleTimingMeta(source)
    indices = new Map(); byIndex = []; userCandidates = new Map(); assistantCandidates = new Map()
    const turns: TimingTurn[] = []
    let turn: TimingTurn | undefined
    for (let index = 0; index < source.length; index++) {
      const message = source[index], occurrences = indices.get(message.id) ?? []
      occurrences.push(index); indices.set(message.id, occurrences)
      if (message.role === "user") {
        turn = { userIndex: index, endIndex: index, assistantId: null,
          userTime: getCreatedTime(message), endTime: null }
        turns.push(turn)
        const candidates = userCandidates.get(message.id) ?? []
        candidates.push(turn); userCandidates.set(message.id, candidates)
      }
      if (turn) {
        turn.endIndex = index
        if (message.role === "assistant" && turn.assistantId === null) turn.assistantId = message.id
        byIndex[index] = turn
      }
    }
    for (const turn of turns) {
      turn.endTime = getEndTime(source[turn.endIndex])
      if (turn.assistantId !== null) {
        const candidates = assistantCandidates.get(turn.assistantId) ?? []
        candidates.push(turn); assistantCandidates.set(turn.assistantId, candidates)
      }
    }
  }
  return (projection: ChatMessageProjection): ReturnType<typeof buildMessageBubbleTimingMeta> => {
    if (!result || source !== projection.messages || structure !== projection.structureVersion) {
      rebuild(projection)
      content = projection.contentVersion
      return result!
    }
    if (content === projection.contentVersion) return result
    content = projection.contentVersion
    // A legacy/incomplete producer cannot silently present stale timing. Actual chat
    // projections publish a fresh complete changed-slot list on every content revision.
    if (!projection.changedMessages.length) { rebuild(projection); return result! }
    const dirtyUsers = new Set<string>(), dirtyAssistants = new Set<string>()
    for (const changed of projection.changedMessages) {
      for (const index of indices.get(changed.id) ?? []) {
        const turn = byIndex[index]
        if (!turn || (index !== turn.userIndex && index !== turn.endIndex)) continue
        const message = projection.messages[index]
        if (index === turn.userIndex) {
          turn.userTime = getCreatedTime(message)
          dirtyUsers.add(message.id)
        }
        if (index === turn.endIndex) turn.endTime = getEndTime(message)
        if (turn.assistantId !== null) dirtyAssistants.add(turn.assistantId)
      }
    }
    let changed = false
    const update = <T>(map: Map<string, T>, id: string, value: T | undefined) => {
      if (value === undefined) { changed = map.delete(id) || changed; return }
      if (map.get(id) !== value) { map.set(id, value); changed = true }
    }
    for (const id of dirtyUsers) {
      let label: string | undefined
      for (const turn of userCandidates.get(id) ?? []) {
        if (turn.userTime !== null) label = formatMessageTimeLabel(turn.userTime) ?? label
      }
      update(result.userSendTimeLabelById, id, label)
    }
    for (const id of dirtyAssistants) {
      let duration: number | undefined
      for (const turn of assistantCandidates.get(id) ?? [])
        if (turn.userTime !== null && turn.endTime !== null)
          duration = Math.max(0, turn.endTime - turn.userTime)
      update(result.assistantDurationMsById, id, duration)
    }
    if (changed) result = { ...result }
    return result
  }
}
