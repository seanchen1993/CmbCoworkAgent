import { SkillUsageDetector } from "../agent/skill-evolution/usage-detector"
import { ToolCallCounter } from "../agent/skill-evolution/tool-call-counter"
import type { StopHookContext } from "../agent/skill-lifecycle/completion-hooks"
import { StreamAssistantText } from "./stream-assistant-text"
import {
  getSelectedStreamTranscriptValueSnapshots,
  getStreamTranscriptValueLocalOccurrence,
  selectStreamTranscriptValueSnapshots
} from "./stream-transcript-values"

const MAX_STOP_CONTEXT_TEXT_CHARS = 40_000
const COORDINATOR_INTERNAL_NOTIFICATION_MESSAGE_KEY = "cmb_internal_coordinator_notification"
const COORDINATOR_VISIBLE_USER_MESSAGE_KEY = "cmb_visible_user_message"
export const STOP_HOOK_REVISION_PROMPT_PREFIX = "[[CMBDEVCLAW_STOP_HOOK_REVISION]]"

export interface SerializedHookMessage {
  id?: string[]
  content?: unknown
  additional_kwargs?: Record<string, unknown>
  kwargs?: {
    id?: string
    type?: string
    content?: unknown
    name?: string
    tool_call_id?: string
    additional_kwargs?: Record<string, unknown>
    tool_calls?: Array<{
      id?: string
      name?: string
      args?: Record<string, unknown>
    }>
  }
}

function isCoordinatorInternalNotificationMessage(
  message: SerializedHookMessage | undefined
): boolean {
  const additionalKwargs = message?.additional_kwargs ?? message?.kwargs?.additional_kwargs
  return additionalKwargs?.[COORDINATOR_INTERNAL_NOTIFICATION_MESSAGE_KEY] === true
}

function getCoordinatorVisibleUserMessage(
  message: SerializedHookMessage | undefined
): string | undefined {
  const additionalKwargs = message?.additional_kwargs ?? message?.kwargs?.additional_kwargs
  const visible = additionalKwargs?.[COORDINATOR_VISIBLE_USER_MESSAGE_KEY]
  return typeof visible === "string" && visible.trim() ? visible : undefined
}

function trimStopContextText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_STOP_CONTEXT_TEXT_CHARS) return trimmed
  return `${trimmed.slice(0, MAX_STOP_CONTEXT_TEXT_CHARS)}\n...(truncated)`
}

function extractStopContextText(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (!Array.isArray(raw)) return ""
  return raw
    .map((block) => {
      if (typeof block === "string") return block
      if (!block || typeof block !== "object") return ""
      const item = block as { type?: string; text?: string; content?: string }
      if (typeof item.text === "string") return item.text
      if (typeof item.content === "string") return item.content
      return ""
    })
    .filter(Boolean)
    .join("")
}

function isStopHookRevisionPrompt(text: string): boolean {
  return text.trimStart().startsWith(STOP_HOOK_REVISION_PROMPT_PREFIX)
}

function stopContextRole(
  className: string,
  kwargs: SerializedHookMessage["kwargs"]
): "user" | "assistant" | "tool" | "system" | "unknown" {
  if (className.includes("Human")) return "user"
  if (className.includes("AI")) return "assistant"
  if (className.includes("Tool")) return "tool"
  if (className.includes("System")) return "system"
  if (kwargs?.type === "human") return "user"
  if (kwargs?.type === "ai") return "assistant"
  if (kwargs?.type === "tool") return "tool"
  if (kwargs?.type === "system") return "system"
  return "unknown"
}

export class StopHookContextCollector {
  private userMessage?: string
  private currentUserId?: string
  private readonly assistantText = new StreamAssistantText(MAX_STOP_CONTEXT_TEXT_CHARS + 1)
  private latestFinalAssistantResponse: string | undefined
  private readonly countedAiMessageIds = new Set<string>()
  private readonly toolCallCounter = new ToolCallCounter()
  private readonly skillUsageDetector = new SkillUsageDetector()

  constructor(userMessage?: string) {
    if (userMessage) this.userMessage = userMessage
  }

  processStreamChunk(mode: string, payload: unknown): void {
    try {
      if (mode === "messages") {
        this.processMessagePayload(payload)
        return
      }
      if (mode === "values") {
        this.processValuesPayload(payload)
      }
    } catch (error) {
      console.warn("[Hooks] Failed to collect Stop hook context:", error)
    }
  }

  snapshot(overrides: StopHookContext = {}): StopHookContext {
    const context: StopHookContext = {}
    const userMessage = overrides.userMessage ?? this.userMessage
    const assistantResponse =
      overrides.assistantResponse ??
      this.latestFinalAssistantResponse ??
      this.assistantText.text.trim()
    const toolCalls =
      overrides.toolCalls && overrides.toolCalls.length > 0
        ? overrides.toolCalls
        : this.toolCallCounter.getNames()
    const usedSkills =
      overrides.usedSkills && overrides.usedSkills.length > 0
        ? overrides.usedSkills
        : this.skillUsageDetector.getUsedSkillNames()

    if (userMessage) context.userMessage = trimStopContextText(userMessage)
    if (assistantResponse) context.assistantResponse = trimStopContextText(assistantResponse)
    if (toolCalls.length > 0) context.toolCalls = toolCalls
    if (usedSkills.length > 0) context.usedSkills = usedSkills
    return context
  }

  private processMessagePayload(payload: unknown): void {
    const [msgChunk] = payload as [SerializedHookMessage]
    if (!msgChunk) return
    if (isCoordinatorInternalNotificationMessage(msgChunk)) {
      this.observeUserIdentity(msgChunk.kwargs?.id)
      return
    }
    const kwargs = msgChunk.kwargs || {}
    const classId = Array.isArray(msgChunk.id) ? msgChunk.id : []
    const className = classId[classId.length - 1] || ""
    const role = stopContextRole(className, kwargs)
    const visibleUserMessage = getCoordinatorVisibleUserMessage(msgChunk)
    const text = visibleUserMessage ?? extractStopContextText(kwargs.content ?? msgChunk.content)

    if (role === "user") this.observeUserIdentity(kwargs.id)
    if (this.assistantText.processMessage(payload)) this.latestFinalAssistantResponse = undefined

    if (role === "user" && text.trim() && !isStopHookRevisionPrompt(text)) {
      this.userMessage = text.trim()
    }
    if (role === "assistant") {
      this.observeToolCalls(kwargs.tool_calls, kwargs.id ?? "")
    }
  }

  private processValuesPayload(payload: unknown): void {
    const state = payload as {
      skillsMetadata?: Array<{ name?: string; path?: string }>
      messages?: SerializedHookMessage[]
    }
    if (Array.isArray(state.skillsMetadata) && state.skillsMetadata.length > 0) {
      this.skillUsageDetector.onSkillsMetadata(state.skillsMetadata)
    }
    if (!Array.isArray(state.messages)) return

    let lastUserIndex = -1
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i]
      if (isCoordinatorInternalNotificationMessage(msg)) {
        this.observeUserIdentity(msg.kwargs?.id)
        lastUserIndex = i
        break
      }
      const kwargs = msg?.kwargs || {}
      const classId = Array.isArray(msg?.id) ? msg.id : []
      const className = classId[classId.length - 1] || ""
      if (stopContextRole(className, kwargs) !== "user") continue
      const visibleUserMessage = getCoordinatorVisibleUserMessage(msg)
      const text = (
        visibleUserMessage ?? extractStopContextText(kwargs.content ?? msg.content)
      ).trim()
      if (text && !isStopHookRevisionPrompt(text)) {
        this.observeUserIdentity(kwargs.id)
        this.userMessage = text
        lastUserIndex = i
        break
      }
    }

    const startIndex = lastUserIndex >= 0 ? lastUserIndex + 1 : 0
    const snapshots =
      getSelectedStreamTranscriptValueSnapshots(payload) ??
      selectStreamTranscriptValueSnapshots({ messages: state.messages.slice(startIndex) })
    for (const tuple of snapshots) {
      const msg = tuple[0] as SerializedHookMessage
      const kwargs = msg?.kwargs || {}
      const classId = Array.isArray(msg?.id) ? msg.id : []
      const className = classId[classId.length - 1] || ""
      const role = stopContextRole(className, kwargs)
      if (role !== "assistant") continue

      const aiMessageId = typeof kwargs.id === "string" ? kwargs.id : ""
      this.observeToolCalls(kwargs.tool_calls, aiMessageId)
      const text = extractStopContextText(kwargs.content ?? msg.content).trim()
      const content = kwargs.content ?? msg.content
      if (typeof content === "string" || Array.isArray(content)) {
        this.assistantText.applySnapshot(
          msg,
          undefined,
          getStreamTranscriptValueLocalOccurrence(tuple)
        )
        this.latestFinalAssistantResponse = kwargs.tool_calls?.length ? undefined : text
      }
    }
  }

  private observeUserIdentity(id: string | undefined): void {
    if (!id) return
    if (this.currentUserId !== undefined && this.currentUserId !== id) {
      // Keep the run's text, but lookup ordinals belong to each current turn.
      this.assistantText.beginSegment()
      this.latestFinalAssistantResponse = undefined
    }
    this.currentUserId = id
  }

  private observeToolCalls(
    toolCalls: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> | undefined,
    aiMessageId: string
  ): void {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return
    if (aiMessageId && this.countedAiMessageIds.has(aiMessageId)) return
    if (aiMessageId) this.countedAiMessageIds.add(aiMessageId)

    for (let index = 0; index < toolCalls.length; index++) {
      const toolCall = toolCalls[index]
      this.toolCallCounter.register(toolCall, aiMessageId, index)
      if (toolCall.name !== "read_file") continue
      const readPathRaw =
        (typeof toolCall.args?.path === "string" && toolCall.args.path) ||
        (typeof toolCall.args?.file_path === "string" && toolCall.args.file_path) ||
        ""
      if (readPathRaw) this.skillUsageDetector.onReadFilePath(readPathRaw)
    }
  }
}
