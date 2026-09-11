import type { Message } from "@/types"
import {
  GOAL_USER_MESSAGE_EVENT_PREFIX,
  isStaleCheckpointBoundaryNoticeMessage
} from "../../../shared/goal-events"
import { splitGoalTransportPayload } from "../../../shared/goal-slash"
import { stripLegacyGoalTransportSummary } from "./goal-transport-summary"

export interface GoalNoticeEvent {
  event_id: number
  goal_id?: string | null
  active_window_id?: string | null
  message: string
  created_at: Date | string | number
  transcript_ordinal?: number | null
  transcript_message_id?: string | null
}

function toTime(value: Date | string | number | null | undefined): number | null {
  if (value == null) return null
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

export function shouldSuppressCheckpointApprovalRestore(
  events: readonly Pick<GoalNoticeEvent, "message" | "created_at">[],
  latestCheckpointMessageAt?: Date | string | number | null
): boolean {
  const latestCheckpointTime = toTime(latestCheckpointMessageAt)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const message = event.message.trim()
    if (isStaleCheckpointBoundaryNoticeMessage(message)) {
      const boundaryTime = toTime(event.created_at)
      if (
        latestCheckpointTime != null &&
        boundaryTime != null &&
        latestCheckpointTime > boundaryTime
      ) {
        return false
      }
      return true
    }
  }
  return false
}

function toDate(value: Date | string | number): Date {
  if (value instanceof Date) return value
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : new Date()
}

function nextNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function createGoalNoticeMessage(
  message: string,
  options: { id?: string; createdAt?: Date; goalId?: string | null; activeWindowId?: string | null } = {}
): Message {
  const createdAt = options.createdAt ?? new Date()
  return {
    id: options.id ?? `goal-notice-${Date.now()}-${nextNoticeId()}`,
    role: "system",
    content: message.trim(),
    created_at: createdAt,
    start_at: createdAt,
    end_at: createdAt,
    goal_id: options.goalId ?? null,
    active_window_id: options.activeWindowId ?? null
  }
}

function createGoalUserMessage(
  content: string,
  options: { id: string; createdAt: Date; goalId?: string | null; activeWindowId?: string | null }
): Message {
  return {
    id: options.id,
    role: "user",
    content: content.trim(),
    created_at: options.createdAt,
    start_at: options.createdAt,
    end_at: options.createdAt,
    goal_id: options.goalId ?? null,
    active_window_id: options.activeWindowId ?? null
  }
}

export function goalEventToSystemMessage(event: GoalNoticeEvent): Message {
  const createdAt = toDate(event.created_at)
  return createGoalNoticeMessage(event.message, {
    id: `goal-event-${event.event_id}`,
    createdAt,
    goalId: event.goal_id ?? null,
    activeWindowId: event.active_window_id ?? null
  })
}

function isGoalUserEvent(message: string): boolean {
  return message.startsWith(GOAL_USER_MESSAGE_EVENT_PREFIX)
}

function commandFromLegacyNotice(message: string): string | null {
  if (message.startsWith("当前没有 active goal。用 /goal ")) return "/goal"
  if (message.startsWith("Goal 已清除")) return "/goal clear"
  if (message.startsWith("Goal 已继续：")) return "/goal resume"
  if (
    (message.startsWith("● Goal 进行中") ||
      message.startsWith("Goal 已暂停") ||
      message.startsWith("Ⅱ Goal 已暂停") ||
      message.startsWith("✓ Goal 已完成")) &&
    message.includes("\n目标：")
  ) {
    return "/goal"
  }
  return null
}

export function goalEventToDisplayMessages(event: GoalNoticeEvent): Message[] {
  const createdAt = toDate(event.created_at)
  if (isGoalUserEvent(event.message)) {
    return [
      createGoalUserMessage(event.message.slice(GOAL_USER_MESSAGE_EVENT_PREFIX.length), {
        id: `goal-user-event-${event.event_id}`,
        createdAt,
        goalId: event.goal_id ?? null,
        activeWindowId: event.active_window_id ?? null
      })
    ]
  }

  const notice = goalEventToSystemMessage(event)
  const legacyCommand = commandFromLegacyNotice(event.message)
  if (!legacyCommand) return [notice]

  return [
    createGoalUserMessage(legacyCommand, {
      id: `goal-legacy-command-${event.event_id}`,
      createdAt,
      goalId: event.goal_id ?? null,
      activeWindowId: event.active_window_id ?? null
    }),
    notice
  ]
}

export function isInternalGoalPromptMessage(message: Pick<Message, "role" | "content">): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false
  const content = message.content.trimStart()
  const hasInternalMarker =
    content.startsWith("[Starting active goal]") || content.startsWith("[Continuing active goal]")
  if (!hasInternalMarker) return false
  return (
    content.includes("<untrusted_objective>") ||
    content.includes("<untrusted_completion_condition>") ||
    content.includes("<completion_condition>")
  )
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

function extractXmlBlock(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`).exec(content)
  return match ? unescapeXmlText(match[1].trim()) : null
}

export function normalizeRestoredGoalPromptMessage(message: Message): Message | null {
  if (!isInternalGoalPromptMessage(message) || typeof message.content !== "string") return message
  const content = message.content.trimStart()
  if (content.startsWith("[Continuing active goal]")) return null

  const objective = extractXmlBlock(content, "untrusted_objective")
  return createGoalUserMessage(objective ? `/goal ${objective}` : "/goal", {
    id: `goal-start-prompt-${message.id}`,
    createdAt: message.start_at ?? message.created_at
  })
}

function getMessageTime(message: Message): number {
  const value = message.start_at ?? message.created_at ?? message.end_at
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER
}

function hasReliableMessageTime(message: Message): boolean {
  return getMessageTime(message) !== Number.MAX_SAFE_INTEGER
}

function isRestoredGoalUserMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    (message.id.startsWith("goal-user-event-") ||
      message.id.startsWith("goal-start-prompt-") ||
      message.id.startsWith("goal-legacy-command-"))
  )
}

function isLegacyRestoredGoalUserMessage(message: Message): boolean {
  return message.role === "user" && message.id.startsWith("goal-legacy-command-")
}

function isPersistedRestoredGoalUserMessage(message: Message): boolean {
  return message.role === "user" && message.id.startsWith("goal-user-event-")
}

function isPromptRestoredGoalUserMessage(message: Message): boolean {
  return message.role === "user" && message.id.startsWith("goal-start-prompt-")
}

function goalCommandContent(message: Message): string | null {
  if (message.role !== "user" || typeof message.content !== "string") return null
  const content = message.content.trim()
  return content.startsWith("/goal") ? content : null
}

function normalizedGoalCommandContent(content: string): string {
  const { commandText } = splitGoalTransportPayload(content)
  const stripped = stripLegacyGoalTransportSummary(commandText, { stripGeneratedSummary: true }).text
  return stripped
    .replace(/(?:^|\n)\s*启动附件：[^\n]*(?=\n|$)/g, "")
    .replace(/(?:^|\n)\s*显式技能：[^\n]*(?=\n|$)/g, "")
    .trim()
}

function goalCommandDuplicateKey(message: Message, content: string): string {
  const normalizedContent = normalizedGoalCommandContent(content)
  if (!isRestoredGoalUserMessage(message)) return normalizedContent
  return `${normalizedContent}\u0000${message.goal_id ?? ""}`
}

const visibleGoalCommandDuplicateWindowMs = 2_000

function addCommandTime(commands: Map<string, number[]>, key: string, time: number): void {
  const times = commands.get(key) ?? []
  times.push(time)
  commands.set(key, times)
}

function consumeNearbyCommand(
  commands: Map<string, number[]>,
  key: string,
  time: number,
  windowMs = 10_000
): boolean {
  const times = commands.get(key)
  if (!times || times.length === 0) return false
  const index = times.findIndex((existingTime) => Math.abs(existingTime - time) <= windowMs)
  if (index < 0) return false
  times.splice(index, 1)
  if (times.length === 0) commands.delete(key)
  return true
}

function findNearbyDuplicateRestoredGoalCommandIndex(
  duplicateIndexesByCommand: Map<string, number[]>,
  deduped: Message[],
  key: string,
  messageTime: number,
  windowMs = 5_000
): number {
  const indexes = duplicateIndexesByCommand.get(key)
  if (!indexes || indexes.length === 0) return -1
  for (const index of indexes) {
    const existing = deduped[index]
    if (!existing || !isRestoredGoalUserMessage(existing)) continue
    if (Math.abs(getMessageTime(existing) - messageTime) <= windowMs) {
      return index
    }
  }
  return -1
}

function consumeNearbyVisibleGoalCommand(
  commands: Map<string, number[]>,
  content: string,
  message: Message,
  time: number
): boolean {
  const normalizedContent = normalizedGoalCommandContent(content)
  if (message.goal_id) {
    return consumeNearbyCommand(commands, `${normalizedContent}\u0000${message.goal_id}`, time)
  }
  return consumeNearbyCommand(commands, normalizedContent, time, visibleGoalCommandDuplicateWindowMs)
}

function dedupeRestoredGoalUserMessages(messages: Message[]): Message[] {
  const visibleGoalCommands = new Map<string, number[]>()
  const persistedGoalCommands = new Map<string, number[]>()
  const anyNonPromptGoalCommands = new Set<string>()

  for (const message of messages) {
    const content = goalCommandContent(message)
    if (!content) continue
    if (!isPromptRestoredGoalUserMessage(message)) {
      anyNonPromptGoalCommands.add(content)
    }
    if (isPersistedRestoredGoalUserMessage(message)) {
      addCommandTime(
        persistedGoalCommands,
        normalizedGoalCommandContent(content),
        getMessageTime(message)
      )
    } else if (!isRestoredGoalUserMessage(message)) {
      addCommandTime(
        visibleGoalCommands,
        message.goal_id
          ? `${normalizedGoalCommandContent(content)}\u0000${message.goal_id}`
          : normalizedGoalCommandContent(content),
        getMessageTime(message)
      )
    }
  }

  const deduped: Message[] = []
  const duplicateIndexesByCommand = new Map<string, number[]>()
  for (const message of messages) {
    const content = goalCommandContent(message)
    if (content && isRestoredGoalUserMessage(message)) {
      const messageTime = getMessageTime(message)
      if (isPromptRestoredGoalUserMessage(message) && anyNonPromptGoalCommands.has(content)) {
        continue
      }

      if (consumeNearbyVisibleGoalCommand(visibleGoalCommands, content, message, messageTime)) {
        continue
      }

      if (
        (isPromptRestoredGoalUserMessage(message) || isLegacyRestoredGoalUserMessage(message)) &&
        consumeNearbyCommand(
          persistedGoalCommands,
          normalizedGoalCommandContent(content),
          messageTime
        )
      ) {
        continue
      }

      const duplicateIndex = findNearbyDuplicateRestoredGoalCommandIndex(
        duplicateIndexesByCommand,
        deduped,
        goalCommandDuplicateKey(message, content),
        messageTime
      )
      if (duplicateIndex >= 0) {
        if (
          isLegacyRestoredGoalUserMessage(deduped[duplicateIndex]) &&
          !isLegacyRestoredGoalUserMessage(message)
        ) {
          deduped[duplicateIndex] = message
        }
        continue
      }
    }
    deduped.push(message)
    if (content && isRestoredGoalUserMessage(message)) {
      const key = goalCommandDuplicateKey(message, content)
      const indexes = duplicateIndexesByCommand.get(key) ?? []
      indexes.push(deduped.length - 1)
      duplicateIndexesByCommand.set(key, indexes)
    }
  }
  return deduped
}

function messageTimelinePriority(message: Message): number {
  if (message.role === "user") return 0
  if (isTerminalGoalNotice(message)) return 4
  if (isGoalCommandNotice(message)) return 1
  if (message.role === "tool" || message.role === "assistant") return 2
  return 2
}

function orderMessagesByTimeline(messages: Message[]): Message[] {
  if (messages.length <= 1 || !messages.some((message) => message.role === "system")) {
    return messages
  }

  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const leftTime = getMessageTime(left.message)
      const rightTime = getMessageTime(right.message)
      if (leftTime !== rightTime) return leftTime - rightTime

      const leftHasTime = hasReliableMessageTime(left.message)
      const rightHasTime = hasReliableMessageTime(right.message)
      if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1

      const priorityDelta =
        messageTimelinePriority(left.message) - messageTimelinePriority(right.message)
      if (priorityDelta !== 0) return priorityDelta

      return left.index - right.index
    })
    .map((entry) => entry.message)
}

export function mergeGoalNoticeMessagesForRestore(
  messages: Message[],
  goalMessages: Message[]
): Message[] {
  if (goalMessages.length === 0) return messages
  if (messages.length === 0) {
    return orderCommandNoticesAfterCommands(
      orderMessagesByTimeline(dedupeRestoredGoalUserMessages(goalMessages))
    )
  }
  return orderCommandNoticesAfterCommands(
    orderMessagesByTimeline(dedupeRestoredGoalUserMessages([...messages, ...goalMessages]))
  )
}

function isTerminalGoalNotice(message: Message): boolean {
  if (message.role !== "system" || typeof message.content !== "string") return false
  return (
    message.content.startsWith("✓ Goal 已完成") ||
    message.content.startsWith("Goal 等待补充信息") ||
    message.content.startsWith("Goal 已暂停") ||
    message.content.startsWith("Ⅱ Goal 已暂停")
  )
}

function isGoalCommandNotice(message: Message): boolean {
  if (message.role !== "system" || typeof message.content !== "string") return false
  return (
    message.content.startsWith("当前没有 active goal。") ||
    message.content.startsWith("Goal 已设置") ||
    message.content.startsWith("Goal 已清除") ||
    message.content.startsWith("Goal 已继续") ||
    message.content.startsWith("Goal 当前状态") ||
    message.content.startsWith("没有可继续的 goal。") ||
    message.content.startsWith("附件和显式技能不会用于 /goal 控制命令")
  )
}

function isResponseMessage(message: Message): boolean {
  return message.role === "assistant" || message.role === "tool"
}

function normalizeGoalNoticeReason(reason: string): string {
  return reason.trim().replace(/[。.\s]+$/g, "")
}

function waitingForUserInputReason(content: string): string | null {
  if (!content.startsWith("Goal 等待补充信息：")) return null
  const body = content.slice("Goal 等待补充信息：".length)
  return normalizeGoalNoticeReason(body.split("。补充信息后")[0] ?? body)
}

function pausedGoalReason(content: string): string | null {
  if (!content.startsWith("Goal 已暂停：")) return null
  return normalizeGoalNoticeReason(content.slice("Goal 已暂停：".length))
}

function isSameGoalNoticeScope(left: Message, right: Message): boolean {
  if (left.goal_id && right.goal_id) return left.goal_id === right.goal_id
  return Math.abs(getMessageTime(left) - getMessageTime(right)) <= 10 * 60 * 1000
}

function dedupeRedundantWaitingPauseNotices(messages: Message[]): Message[] {
  const waitingNotices: Message[] = []
  const deduped: Message[] = []

  for (const message of messages) {
    if (message.role !== "system" || typeof message.content !== "string") {
      deduped.push(message)
      continue
    }

    const waitingReason = waitingForUserInputReason(message.content)
    if (waitingReason) {
      waitingNotices.push(message)
      deduped.push(message)
      continue
    }

    const pausedReason = pausedGoalReason(message.content)
    if (
      pausedReason &&
      waitingNotices.some(
        (waiting) =>
          typeof waiting.content === "string" &&
          waitingForUserInputReason(waiting.content) === pausedReason &&
          isSameGoalNoticeScope(waiting, message)
      )
    ) {
      continue
    }

    deduped.push(message)
  }

  return deduped
}

function orderCommandNoticesAfterCommands(messages: Message[]): Message[] {
  const ordered: Message[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const nextMessage = messages[index + 1]
    if (
      isGoalCommandNotice(message) &&
      nextMessage &&
      goalCommandContent(nextMessage) &&
      Math.abs(getMessageTime(message) - getMessageTime(nextMessage)) <= 10_000
    ) {
      ordered.push(nextMessage, message)
      index += 1
      continue
    }
    ordered.push(message)
  }

  return ordered
}

function dedupeAdjacentGoalCommandNotices(messages: Message[]): Message[] {
  const deduped: Message[] = []
  for (const message of messages) {
    const previous = deduped[deduped.length - 1]
    if (
      previous &&
      isGoalCommandNotice(previous) &&
      isGoalCommandNotice(message) &&
      previous.content === message.content
    ) {
      continue
    }
    deduped.push(message)
  }
  return deduped
}

export function orderGoalNoticeMessagesForDisplay(messages: Message[]): Message[] {
  const ordered: Message[] = []
  const commandOrderedMessages = dedupeRedundantWaitingPauseNotices(
    orderCommandNoticesAfterCommands(orderMessagesByTimeline(messages))
  )

  for (let index = 0; index < commandOrderedMessages.length; index += 1) {
    const message = commandOrderedMessages[index]
    if (!isTerminalGoalNotice(message)) {
      ordered.push(message)
      continue
    }

    const followingResponseMessages: Message[] = []
    let nextIndex = index + 1
    while (
      nextIndex < commandOrderedMessages.length &&
      isResponseMessage(commandOrderedMessages[nextIndex])
    ) {
      followingResponseMessages.push(commandOrderedMessages[nextIndex])
      nextIndex += 1
    }

    if (followingResponseMessages.length === 0) {
      ordered.push(message)
      continue
    }

    ordered.push(...followingResponseMessages, message)
    index = nextIndex - 1
  }

  return dedupeAdjacentGoalCommandNotices(ordered)
}
