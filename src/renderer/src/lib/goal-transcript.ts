import type { GoalEvent, Message } from "@/types"
import { GOAL_USER_MESSAGE_EVENT_PREFIX } from "../../../shared/goal-events"
import { isGoalClearAlias, splitGoalTransportPayload } from "../../../shared/goal-slash"
import { isInternalGoalPromptMessage, type GoalNoticeEvent } from "./goal-notice-messages"

export function isGoalTranscriptArtifact(message: Pick<Message, "role" | "content">): boolean {
  if (typeof message.content !== "string") return false
  const content = message.content.trim()
  if (message.role !== "system") return false
  return (
    content.startsWith("Goal ") ||
    content.startsWith("✓ Goal") ||
    content.startsWith("● Goal") ||
    content.startsWith("Ⅱ Goal") ||
    content.startsWith("当前没有 active goal") ||
    content.startsWith("你发送了新消息，active goal 已暂停")
  )
}

export function isVisibleCheckpointTranscriptMessage(
  message: Pick<Message, "role" | "content">
): boolean {
  return !isInternalGoalPromptMessage(message) && !isGoalTranscriptArtifact(message)
}

export function buildCheckpointTranscriptForDisplay(messages: Message[]): Message[] {
  return messages.filter(isVisibleCheckpointTranscriptMessage)
}

export function formatGoalEventMessage(message: string): string {
  const trimmed = message.trim()
  return trimmed.startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)
    ? trimmed.slice(GOAL_USER_MESSAGE_EVENT_PREFIX.length).trim()
    : trimmed
}

export function goalNoticeEventsToGoalUiEvents(
  threadId: string,
  events: readonly GoalNoticeEvent[]
): GoalEvent[] {
  return events.map((event) => ({
    event_id: event.event_id,
    thread_id: threadId,
    goal_id: event.goal_id ?? null,
    active_window_id: event.active_window_id ?? null,
    message: event.message,
    created_at: event.created_at
  }))
}

const toGoalEventDate = (value: Date | string | number): Date => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

export function isGoalUserEvent(event: Pick<GoalEvent, "message">): boolean {
  return event.message.trim().startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)
}

function shouldRestoreGoalUserCommandToTranscript(content: string): boolean {
  const { commandText } = splitGoalTransportPayload(content)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return false

  const arg = trimmed.slice("/goal".length).trim().toLowerCase()
  if (arg === "" || arg === "status" || arg === "pause" || isGoalClearAlias(arg)) {
    return false
  }
  return true
}

export function goalUserEventToMessage(event: GoalEvent): Message | null {
  if (!isGoalUserEvent(event)) return null
  const content = formatGoalEventMessage(event.message)
  if (!shouldRestoreGoalUserCommandToTranscript(content)) return null

  const createdAt = toGoalEventDate(event.created_at)
  return {
    id: `goal-user-event-${event.event_id}`,
    role: "user",
    content,
    goal_id: event.goal_id,
    active_window_id: event.active_window_id ?? null,
    created_at: createdAt,
    start_at: createdAt,
    end_at: createdAt
  }
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function extractXmlBlock(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(content)
  return match ? unescapeXmlText(match[1].trim()) : null
}

function isGoalResumeCommandMessage(message: Message): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false
  const { commandText } = splitGoalTransportPayload(message.content)
  return commandText.trim().toLowerCase() === "/goal resume"
}

function isGoalSetCommandMessage(message: Message): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false
  const { commandText } = splitGoalTransportPayload(message.content)
  const trimmed = commandText.trim()
  if (!/^\/goal(?:\s|$)/i.test(trimmed)) return false
  return !isGoalResumeCommandMessage(message)
}

function normalizedGoalCommandContent(content: string): string {
  const { commandText } = splitGoalTransportPayload(content)
  return commandText
    .replace(/(?:^|\n)\s*启动附件：[^\n]*(?=\n|$)/g, "")
    .replace(/(?:^|\n)\s*显式技能：[^\n]*(?=\n|$)/g, "")
    .trim()
}

function createGoalPromptFallbackMessage(rawMessage: Message): Message | null {
  if (!isInternalGoalPromptMessage(rawMessage) || typeof rawMessage.content !== "string") {
    return null
  }

  const content = rawMessage.content.trimStart()
  const isContinuation = content.startsWith("[Continuing active goal]")
  const objective = extractXmlBlock(content, "untrusted_objective")
  const goalId = extractXmlBlock(content, "goal_id")
  const activeWindowId = extractXmlBlock(content, "active_window_id")
  const createdAt = rawMessage.start_at ?? rawMessage.created_at
  return {
    id: `${isContinuation ? "goal-continue-prompt" : "goal-start-prompt"}-${rawMessage.id}`,
    role: "user",
    content: isContinuation ? "/goal resume" : objective ? `/goal ${objective}` : "/goal",
    goal_id: goalId ?? rawMessage.goal_id,
    active_window_id: activeWindowId ?? rawMessage.active_window_id,
    created_at: createdAt,
    start_at: createdAt,
    end_at: rawMessage.end_at ?? createdAt
  }
}

function findMatchingGoalUserEventMessage(
  rawPrompt: Message,
  goalUserMessages: readonly Message[],
  consumedIds: Set<string>
): Message | null {
  if (!isInternalGoalPromptMessage(rawPrompt) || typeof rawPrompt.content !== "string") return null

  const content = rawPrompt.content.trimStart()
  const isContinuation = content.startsWith("[Continuing active goal]")
  const goalId = extractXmlBlock(content, "goal_id") ?? rawPrompt.goal_id
  const activeWindowId = extractXmlBlock(content, "active_window_id") ?? rawPrompt.active_window_id
  const expectedCommand = isContinuation ? isGoalResumeCommandMessage : isGoalSetCommandMessage
  const fallback = createGoalPromptFallbackMessage(rawPrompt)

  const match = goalUserMessages.find((message) => {
    if (consumedIds.has(message.id)) return false
    if (!expectedCommand(message)) return false
    if (!fallback) return false
    return sameGoalCommandMessage(
      {
        ...fallback,
        goal_id: goalId ?? fallback.goal_id,
        active_window_id: activeWindowId ?? fallback.active_window_id
      },
      message
    )
  })

  if (!match) return null

  const createdAt = rawPrompt.start_at ?? rawPrompt.created_at
  return {
    ...match,
    goal_id: match.goal_id ?? goalId,
    active_window_id: match.active_window_id ?? activeWindowId,
    created_at: createdAt,
    start_at: createdAt,
    end_at: rawPrompt.end_at ?? createdAt
  }
}

const sameGoalCommandMessage = (left: Message, right: Message): boolean => {
  if (left.role !== "user" || right.role !== "user") return false
  if (typeof left.content !== "string" || typeof right.content !== "string") return false
  if (normalizedGoalCommandContent(left.content) !== normalizedGoalCommandContent(right.content)) {
    return false
  }
  if (left.active_window_id || right.active_window_id) {
    return !!left.active_window_id && !!right.active_window_id && left.active_window_id === right.active_window_id
  }
  if (left.goal_id && right.goal_id) return left.goal_id === right.goal_id

  const leftTime = left.created_at?.getTime?.() ?? 0
  const rightTime = right.created_at?.getTime?.() ?? 0
  return Math.abs(leftTime - rightTime) <= 5_000
}

function insertMessagesByTimePreservingCheckpointOrder(
  checkpointMessages: Message[],
  extraMessages: readonly Message[]
): Message[] {
  if (extraMessages.length === 0) return checkpointMessages

  const merged = [...checkpointMessages]
  for (const message of [...extraMessages].sort((left, right) => {
    const timeDelta = left.created_at.getTime() - right.created_at.getTime()
    return timeDelta || left.id.localeCompare(right.id)
  })) {
    if (merged.some((checkpoint) => sameGoalCommandMessage(checkpoint, message))) continue

    const messageTime = message.created_at.getTime()
    let insertAt = merged.findIndex((checkpoint) => checkpoint.created_at.getTime() > messageTime)
    if (insertAt < 0) insertAt = merged.length
    merged.splice(insertAt, 0, message)
  }

  return merged
}

export function buildRestoredCheckpointTranscript(
  rawCheckpointMessages: Message[],
  visibleCheckpointMessages: Message[],
  goalEvents: readonly GoalEvent[]
): Message[] {
  if (rawCheckpointMessages.length === 0) {
    return mergeGoalUserEventsIntoTranscript(visibleCheckpointMessages, goalEvents)
  }

  const goalUserMessages = goalEvents
    .map(goalUserEventToMessage)
    .filter((message): message is Message => !!message)
  const consumedGoalUserMessageIds = new Set<string>()
  const restored: Message[] = []
  let visibleIndex = 0

  for (const rawMessage of rawCheckpointMessages) {
    if (isInternalGoalPromptMessage(rawMessage)) {
      const matched = findMatchingGoalUserEventMessage(
        rawMessage,
        goalUserMessages,
        consumedGoalUserMessageIds
      )
      const replacement = matched ?? createGoalPromptFallbackMessage(rawMessage)
      if (replacement) {
        consumedGoalUserMessageIds.add(replacement.id)
        restored.push(replacement)
      }
      continue
    }

    if (isGoalTranscriptArtifact(rawMessage)) continue

    const visibleMessage = visibleCheckpointMessages[visibleIndex] ?? rawMessage
    visibleIndex += 1
    restored.push(visibleMessage)
  }

  const remainingGoalUserMessages = goalUserMessages.filter(
    (message) => !consumedGoalUserMessageIds.has(message.id)
  )
  return insertMessagesByTimePreservingCheckpointOrder(restored, remainingGoalUserMessages)
}

export function mergeGoalUserEventsIntoTranscript(
  checkpointMessages: Message[],
  goalEvents: readonly GoalEvent[]
): Message[] {
  const syntheticGoalUserMessages = goalEvents
    .map(goalUserEventToMessage)
    .filter((message): message is Message => !!message)
    .filter(
      (message) => !checkpointMessages.some((checkpoint) => sameGoalCommandMessage(checkpoint, message))
    )

  if (syntheticGoalUserMessages.length === 0) return checkpointMessages

  const checkpointIndexById = new Map(
    checkpointMessages.map((message, index) => [message.id, index])
  )
  const merged = [...checkpointMessages, ...syntheticGoalUserMessages]
  merged.sort((left, right) => {
    const timeDelta = left.created_at.getTime() - right.created_at.getTime()
    if (timeDelta !== 0) return timeDelta

    const leftCheckpointIndex = checkpointIndexById.get(left.id) ?? -1
    const rightCheckpointIndex = checkpointIndexById.get(right.id) ?? -1
    if (leftCheckpointIndex >= 0 && rightCheckpointIndex >= 0) {
      return leftCheckpointIndex - rightCheckpointIndex
    }
    if (leftCheckpointIndex >= 0) return -1
    if (rightCheckpointIndex >= 0) return 1
    return left.id.localeCompare(right.id)
  })

  return merged
}
