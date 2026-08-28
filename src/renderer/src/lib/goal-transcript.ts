import type { GoalEvent, Message } from "@/types"
import {
  isVisibleTranscriptMessage,
  isWorkflowPlumbingTranscriptContent
} from "../../../shared/checkpoint-transcript"
import {
  formatGoalUserEventMessage,
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  isVisibleGoalUserEventMessage
} from "../../../shared/goal-events"
import { splitGoalTransportPayload } from "../../../shared/goal-slash"
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
    content.startsWith("你发送了新消息，active goal 已暂停") ||
    content.startsWith("没有可继续的 goal") ||
    content.startsWith("附件和显式技能不会用于 /goal 控制命令")
  )
}

export function isVisibleCheckpointTranscriptMessage(
  message: Pick<Message, "role" | "content">
): boolean {
  return isVisibleTranscriptMessage(message.role, message.content)
}

export function buildCheckpointTranscriptForDisplay(messages: Message[]): Message[] {
  return messages.filter(isVisibleCheckpointTranscriptMessage)
}

export function formatGoalEventMessage(message: string): string {
  return formatGoalUserEventMessage(message)
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

export function goalUserEventToMessage(event: GoalEvent): Message | null {
  if (!isGoalUserEvent(event)) return null
  const content = formatGoalEventMessage(event.message)
  if (!isVisibleGoalUserEventMessage(event.message)) return null

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

export function isGoalResumeCommandContent(content: string): boolean {
  const { commandText } = splitGoalTransportPayload(content)
  return commandText.trim().toLowerCase() === "/goal resume"
}

function isGoalResumeCommandMessage(message: Message): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false
  return isGoalResumeCommandContent(message.content)
}

export type GoalPromptIdentity = {
  goalId?: string | null
  activeWindowId?: string | null
}

export function getInternalGoalPromptIdentity(content: string): GoalPromptIdentity {
  return {
    goalId: extractXmlBlock(content, "goal_id"),
    activeWindowId: extractXmlBlock(content, "active_window_id")
  }
}

export function hasGoalResumeUserEvent(
  events: ReadonlyArray<
    Pick<GoalEvent, "message"> & Partial<Pick<GoalEvent, "goal_id" | "active_window_id">>
  >,
  identity: GoalPromptIdentity = {}
): boolean {
  return events.some(
    (event) => {
      if (!isGoalUserEvent(event)) return false
      if (!isGoalResumeCommandContent(formatGoalEventMessage(event.message))) return false
      if (identity.activeWindowId) {
        return event.active_window_id === identity.activeWindowId
      }
      if (identity.goalId) {
        return event.goal_id === identity.goalId
      }
      return true
    }
  )
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

function shouldCreateGoalPromptFallbackMessage(rawMessage: Message): boolean {
  if (!isInternalGoalPromptMessage(rawMessage) || typeof rawMessage.content !== "string") {
    return false
  }
  return !rawMessage.content.trimStart().startsWith("[Continuing active goal]")
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

  const createdAt = match.start_at ?? match.created_at
  const endAt = match.end_at ?? createdAt
  return {
    ...match,
    goal_id: match.goal_id ?? goalId,
    active_window_id: match.active_window_id ?? activeWindowId,
    created_at: createdAt,
    start_at: createdAt,
    end_at: endAt
  }
}

export const sameGoalCommandMessage = (left: Message, right: Message): boolean => {
  if (left.role !== "user" || right.role !== "user") return false
  if (typeof left.content !== "string" || typeof right.content !== "string") return false
  if (normalizedGoalCommandContent(left.content) !== normalizedGoalCommandContent(right.content)) {
    return false
  }
  if (left.active_window_id && right.active_window_id) {
    return left.active_window_id === right.active_window_id
  }
  if (left.goal_id && right.goal_id) return left.goal_id === right.goal_id

  const leftTime = left.created_at?.getTime?.() ?? 0
  const rightTime = right.created_at?.getTime?.() ?? 0
  return Math.abs(leftTime - rightTime) <= 5_000
}

const GOAL_COMMAND_MATCH_WINDOW_MS = 5_000

interface GoalCommandTimeBucket {
  min: number
  max: number
}

type GoalCommandTimeIndex = Map<number, GoalCommandTimeBucket>

interface GoalCommandContentIndex {
  activeWindowIds: Set<string>
  goalIds: Set<string>
  goalIdsWithoutActiveWindow: Set<string>
  allTimes: GoalCommandTimeIndex
  timesWithoutActiveWindow: GoalCommandTimeIndex
  timesWithoutGoal: GoalCommandTimeIndex
  timesWithoutActiveWindowOrGoal: GoalCommandTimeIndex
}

interface IndexedGoalCommand {
  content: string
  activeWindowId: string | null
  goalId: string | null
  time: number
}

function indexedGoalCommand(message: Message): IndexedGoalCommand | null {
  if (message.role !== "user" || typeof message.content !== "string") return null
  const time = message.created_at?.getTime?.() ?? 0
  return {
    content: normalizedGoalCommandContent(message.content),
    activeWindowId: message.active_window_id ?? null,
    goalId: message.goal_id ?? null,
    time: Number.isFinite(time) ? time : 0
  }
}

function addGoalCommandTime(index: GoalCommandTimeIndex, time: number): void {
  const bucketId = Math.floor(time / GOAL_COMMAND_MATCH_WINDOW_MS)
  const bucket = index.get(bucketId)
  if (!bucket) {
    index.set(bucketId, { min: time, max: time })
    return
  }
  bucket.min = Math.min(bucket.min, time)
  bucket.max = Math.max(bucket.max, time)
}

function hasGoalCommandTime(index: GoalCommandTimeIndex, time: number): boolean {
  const minimum = time - GOAL_COMMAND_MATCH_WINDOW_MS
  const maximum = time + GOAL_COMMAND_MATCH_WINDOW_MS
  const firstBucket = Math.floor(minimum / GOAL_COMMAND_MATCH_WINDOW_MS)
  const lastBucket = Math.floor(maximum / GOAL_COMMAND_MATCH_WINDOW_MS)
  for (let bucketId = firstBucket; bucketId <= lastBucket; bucketId += 1) {
    const bucket = index.get(bucketId)
    if (bucket && bucket.max >= minimum && bucket.min <= maximum) return true
  }
  return false
}

function createGoalCommandContentIndex(): GoalCommandContentIndex {
  return {
    activeWindowIds: new Set(),
    goalIds: new Set(),
    goalIdsWithoutActiveWindow: new Set(),
    allTimes: new Map(),
    timesWithoutActiveWindow: new Map(),
    timesWithoutGoal: new Map(),
    timesWithoutActiveWindowOrGoal: new Map()
  }
}

class GoalCommandDuplicateIndex {
  private readonly byContent = new Map<string, GoalCommandContentIndex>()

  constructor(messages: readonly Message[] = []) {
    for (const message of messages) this.add(message)
  }

  add(message: Message): void {
    const command = indexedGoalCommand(message)
    if (!command) return
    const contentIndex = this.byContent.get(command.content) ?? createGoalCommandContentIndex()
    this.byContent.set(command.content, contentIndex)

    if (command.activeWindowId) contentIndex.activeWindowIds.add(command.activeWindowId)
    if (command.goalId) {
      contentIndex.goalIds.add(command.goalId)
      if (!command.activeWindowId) {
        contentIndex.goalIdsWithoutActiveWindow.add(command.goalId)
      }
    }
    addGoalCommandTime(contentIndex.allTimes, command.time)
    if (!command.activeWindowId) {
      addGoalCommandTime(contentIndex.timesWithoutActiveWindow, command.time)
    }
    if (!command.goalId) addGoalCommandTime(contentIndex.timesWithoutGoal, command.time)
    if (!command.activeWindowId && !command.goalId) {
      addGoalCommandTime(contentIndex.timesWithoutActiveWindowOrGoal, command.time)
    }
  }

  hasEquivalent(message: Message): boolean {
    const command = indexedGoalCommand(message)
    if (!command) return false
    const contentIndex = this.byContent.get(command.content)
    if (!contentIndex) return false

    if (command.activeWindowId) {
      if (contentIndex.activeWindowIds.has(command.activeWindowId)) return true
      if (
        command.goalId &&
        contentIndex.goalIdsWithoutActiveWindow.has(command.goalId)
      ) {
        return true
      }
      return hasGoalCommandTime(
        command.goalId
          ? contentIndex.timesWithoutActiveWindowOrGoal
          : contentIndex.timesWithoutActiveWindow,
        command.time
      )
    }

    if (command.goalId) {
      return (
        contentIndex.goalIds.has(command.goalId) ||
        hasGoalCommandTime(contentIndex.timesWithoutGoal, command.time)
      )
    }
    return hasGoalCommandTime(contentIndex.allTimes, command.time)
  }
}

function insertMessagesByTimePreservingCheckpointOrder(
  checkpointMessages: Message[],
  extraMessages: readonly Message[],
  pageStartTime = checkpointMessages[0]?.created_at.getTime() ?? Number.NEGATIVE_INFINITY
): Message[] {
  if (extraMessages.length === 0) return checkpointMessages

  const checkpointCommands = new GoalCommandDuplicateIndex(checkpointMessages)
  const eligibleMessages = extraMessages.filter(
    (message) =>
      message.created_at.getTime() >= pageStartTime &&
      !checkpointCommands.hasEquivalent(message)
  )
  if (eligibleMessages.length === 0) return checkpointMessages

  // Goal restore rows are chronological by contract. Merge the two ordered
  // inputs directly so hydration remains O(messages + events).
  const merged: Message[] = []
  let extraIndex = 0
  for (const checkpoint of checkpointMessages) {
    const checkpointTime = checkpoint.created_at.getTime()
    while (
      extraIndex < eligibleMessages.length &&
      eligibleMessages[extraIndex].created_at.getTime() < checkpointTime
    ) {
      merged.push(eligibleMessages[extraIndex])
      extraIndex += 1
    }
    merged.push(checkpoint)
  }
  while (extraIndex < eligibleMessages.length) {
    merged.push(eligibleMessages[extraIndex])
    extraIndex += 1
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
  const restoredGoalCommands = new GoalCommandDuplicateIndex()
  let visibleIndex = 0

  for (const rawMessage of rawCheckpointMessages) {
    if (isInternalGoalPromptMessage(rawMessage)) {
      const matched = findMatchingGoalUserEventMessage(
        rawMessage,
        goalUserMessages,
        consumedGoalUserMessageIds
      )
      const replacement =
        matched ??
        (shouldCreateGoalPromptFallbackMessage(rawMessage)
          ? createGoalPromptFallbackMessage(rawMessage)
          : null)
      if (replacement) {
        consumedGoalUserMessageIds.add(replacement.id)
        restored.push(replacement)
        restoredGoalCommands.add(replacement)
      }
      continue
    }

    if (isGoalTranscriptArtifact(rawMessage)) continue
    if (isWorkflowPlumbingTranscriptContent(rawMessage.content)) continue

    const visibleMessage = visibleCheckpointMessages[visibleIndex] ?? rawMessage
    visibleIndex += 1
    if (restoredGoalCommands.hasEquivalent(visibleMessage)) continue
    restored.push(visibleMessage)
    restoredGoalCommands.add(visibleMessage)
  }

  const remainingGoalUserMessages = goalUserMessages.filter(
    (message) => !consumedGoalUserMessageIds.has(message.id)
  )
  return insertMessagesByTimePreservingCheckpointOrder(
    restored,
    remainingGoalUserMessages,
    rawCheckpointMessages[0]?.created_at.getTime()
  )
}

export function mergeGoalUserEventsIntoTranscript(
  checkpointMessages: Message[],
  goalEvents: readonly GoalEvent[]
): Message[] {
  const syntheticGoalUserMessages = goalEvents
    .map(goalUserEventToMessage)
    .filter((message): message is Message => !!message)
  return insertMessagesByTimePreservingCheckpointOrder(
    checkpointMessages,
    syntheticGoalUserMessages
  )
}
