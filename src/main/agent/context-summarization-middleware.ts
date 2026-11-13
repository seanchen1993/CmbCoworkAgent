/* eslint-disable @typescript-eslint/no-explicit-any */
import { ContextOverflowError } from "@langchain/core/errors"
import type { BaseLanguageModel } from "@langchain/core/language_models/base"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import type { BaseStore } from "@langchain/langgraph-checkpoint"
import { Command } from "@langchain/langgraph"
import type { BackendFactory, BackendProtocol, StateBackend } from "deepagents"
import {
  AIMessage,
  BaseMessage,
  countTokensApproximately,
  createMiddleware,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from "langchain"
import { initChatModel } from "langchain/chat_models/universal"
import type { ClientTool, ServerTool } from "@langchain/core/tools"
import { z } from "zod"
import {
  repairModelRequestToolCallParity,
  sanitizeModelRequestMessages
} from "./malformed-tool-call-recovery"
import { isWorkflowNotificationPrompt } from "../../shared/internal-notification-turn"
import {
  CompactionDiagnostics,
  compactionErrorDetails,
  type CompactionDiagnosticSink
} from "../services/context-compaction-diagnostics"
import {
  contextWindowFromError,
  excerptUtf8,
  fitSummaryRequestToBytes,
  summaryRequestBytes,
  summaryRetryByteBudget
} from "./context-compaction-recovery"

export interface ContextSize {
  type: "messages" | "tokens" | "fraction"
  value: number
}

export interface TruncateArgsSettings {
  trigger?: ContextSize
  keep?: ContextSize
  maxLength?: number
  truncationText?: string
}

export interface CmbSummarizationMiddlewareOptions {
  model: string | BaseChatModel | BaseLanguageModel
  /**
   * Optional non-thinking model used only after a summary response contains no
   * final text. This mirrors Claude Code's no-text fallback without changing
   * the primary compaction model's reasoning configuration.
   */
  fallbackModel?: string | BaseChatModel | BaseLanguageModel
  /** Same provider with a small output reservation, used only after context overflow. */
  overflowModel?: BaseChatModel | BaseLanguageModel
  summaryMaxOutputTokens?: number
  overflowMaxOutputTokens?: number
  onDiagnostic?: CompactionDiagnosticSink
  backend:
    | BackendProtocol
    | BackendFactory
    | ((config: { state: unknown; store?: BaseStore }) => StateBackend)
  trigger?: ContextSize | ContextSize[]
  keep?: ContextSize
  summaryPrompt?: string
  /**
   * Retry target used only after the summary request itself reports context overflow.
   * The first summary attempt always receives the complete old conversation.
   */
  trimTokensToSummarize?: number
  /**
   * Explicit context-window limit from the runtime configuration. This takes
   * precedence over a model profile, which is often absent for custom
   * OpenAI-compatible model IDs.
   */
  maxInputTokens?: number
  /**
   * Maximum estimated input sent to the outer Agent model after compaction.
   * This value already reserves that model's output and safety space.
   */
  postCompactionInputBudgetTokens?: number
  historyPathPrefix?: string
  /**
   * Optional pre-migration history directory. It is consulted only when the
   * corresponding file does not yet exist beneath historyPathPrefix.
   */
  legacyHistoryPathPrefix?: string
  truncateArgsSettings?: TruncateArgsSettings
  /**
   * Runtime configurable key that identifies an isolated task-subagent
   * invocation. When present, inherited summarization state is only trusted
   * when it was produced by the same invocation.
   */
  stateOwnerConfigKey?: string
}

type InternalArtifactBackend = BackendProtocol & {
  writeInternalArtifact?: (filePath: string, content: string) => Promise<{ error?: string }>
  appendInternalArtifact?: (filePath: string, content: string) => Promise<{ error?: string }>
  internalArtifactExists?: (filePath: string) => Promise<boolean>
}

/** State marker used to bind a summarization event to one task-subagent invocation. */
export const SUMMARIZATION_STATE_OWNER_KEY = "_cmbSummarizationOwner"

const DEFAULT_MESSAGES_TO_KEEP = 20
const DEFAULT_OVERFLOW_RETRY_TARGET = 4_000
const FALLBACK_TRIGGER: ContextSize = { type: "tokens", value: 170_000 }
const FALLBACK_KEEP: ContextSize = { type: "messages", value: 6 }
const FALLBACK_TRUNCATE_ARGS: TruncateArgsSettings = {
  trigger: { type: "messages", value: 20 },
  keep: { type: "messages", value: 20 }
}
const PROFILE_TRIGGER: ContextSize = { type: "fraction", value: 0.85 }
const PROFILE_KEEP: ContextSize = { type: "fraction", value: 0.1 }
const PROFILE_TRUNCATE_ARGS: TruncateArgsSettings = {
  trigger: { type: "fraction", value: 0.85 },
  keep: { type: "fraction", value: 0.1 }
}
const MAX_SUMMARY_MODEL_ATTEMPTS = 4
const MAX_SUMMARY_OVERFLOW_RETRIES = 3
const MAX_SUMMARY_QUALITY_ATTEMPTS = 3
type SummaryAttemptBudget = { used: number; diagnostics?: CompactionDiagnostics }
const EMPTY_SUMMARY_QUALITY_ISSUE = "empty final content"
const TOOL_CALL_SUMMARY_QUALITY_ISSUE = "tool call instead of final text"
const DSML_SUMMARY_QUALITY_ISSUE = "DSML tool-call markup instead of final text"
const COMPACTION_RETRY_MARKER = "[earlier conversation truncated for compaction retry]"
const INITIAL_USER_REQUEST_KEY = "cmb_initial_user_request"
const INITIAL_USER_REQUEST_MAX_CHARS = 3_000
const INITIAL_USER_REQUEST_TRUNCATION_MARKER = "\n...[initial user request middle truncated]...\n"
const LATEST_USER_REQUEST_MAX_CHARS = 3_000
const LATEST_USER_REQUEST_TRUNCATION_MARKER = "\n...[latest user request middle truncated]...\n"
// Keep this intentionally narrower than "any HTTP 400". These are established
// overflow forms used by OpenCode/Grok Build and by CmbCowork's supported
// OpenAI-compatible providers; format/auth/tool-call errors must still surface.
const CONTEXT_OVERFLOW_MESSAGE_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /too long for this model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length/i,
  /maximum context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /model_context_window_exceeded/i,
  /current message.*exceeds budget/i
]
const CONTEXT_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_window_exceeded"
])
// Coordinator worker results are intentionally transported as HumanMessages so
// the coordinator can consume them, but they are system-produced evidence —
// never a new user request to anchor during compaction. Keep this aligned with
// the existing marker set by agent.ts.
const INTERNAL_COORDINATOR_NOTIFICATION_KEY = "cmb_internal_coordinator_notification"
// Hook/skill/coordinator prompt augmentation keeps the user-visible text in
// additional_kwargs while message.content records the effective model input.
// Anchors describe the real user request, so they must follow the same visible
// message contract used by checkpoint transcripts.
const VISIBLE_USER_MESSAGE_KEY = "cmb_visible_user_message"

function overflowCandidateStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) return []
  if (typeof value === "string") return [value]
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const candidates: string[] = []
  for (const key of ["message", "code", "type", "errorMsg", "returnCode"]) {
    const candidate = record[key]
    if (typeof candidate === "string") candidates.push(candidate)
  }
  candidates.push(...overflowCandidateStrings(record.error, depth + 1))
  if (typeof record.responseBody === "string") {
    try {
      candidates.push(...overflowCandidateStrings(JSON.parse(record.responseBody), depth + 1))
    } catch {
      candidates.push(record.responseBody)
    }
  }
  return candidates
}

/** The gateway shares 485/580 with internal failures; require its exact overflow text. */
export function isGatewayContextOverflow(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const candidates = overflowCandidateStrings(error)
  const status = record.status ?? record.statusCode
  const matchesStatus =
    status != null
      ? status === 485 || status === 580
      : candidates.some((candidate) => /^XCDZB(?:485|580)$/.test(candidate.trim()))
  return (
    matchesStatus && candidates.some((candidate) => candidate.includes("任务上下文超过最大限度"))
  )
}

/** Recognise context overflow across LangChain and known OpenAI-compatible
 * gateway shapes without swallowing unrelated 400 errors. */
export function isCmbContextOverflow(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (ContextOverflowError.isInstance(current)) return true
    if (isGatewayContextOverflow(current)) return true

    if (typeof current === "object") {
      const record = current as Record<string, unknown>
      if (record.status === 413 || record.statusCode === 413) return true
    }

    const candidates = overflowCandidateStrings(current)
    if (
      candidates.some((candidate) => {
        const normalized = candidate.trim().toLowerCase()
        return (
          CONTEXT_OVERFLOW_CODES.has(normalized) ||
          CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(candidate))
        )
      })
    ) {
      return true
    }

    current =
      typeof current === "object" && current && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined
  }
  return false
}
const DEFAULT_SUMMARY_PROMPT = `Create a compact continuation handoff from the structured conversation messages above.

Use these exact headings:
## Goal
## Constraints
## Completed
## Current State
## Blockers
## Key Decisions
## Next Step
## Critical Evidence

Use concise, high-information bullets. Preserve exact file paths, commands, errors, identifiers, configuration values, and unresolved decisions when they matter. Explicitly preserve unresolved contradictions between user requirements, current source code, tests, compiled artifacts, workflow reports, and claimed verification results. Do not let a later conclusion hide conflicting evidence. Do not include private reasoning, generic narrative, or a verbatim transcript. Treat any <previous-summary> as authoritative context: retain facts that are still true, update changed facts, and remove stale facts.`

const SUMMARY_TEXT_ONLY_INSTRUCTION =
  "Do not call, request, or imitate any tool. Do not emit tool-call markup or arguments. Return only the continuation handoff as text in the final content field."

const SummarizationEventSchema = z.object({
  cutoffIndex: z.number(),
  // Checkpointers can restore a valid message through a different module or
  // serialization boundary. LangChain's branded guard is cross-runtime safe;
  // JavaScript instanceof can reject "HumanMessage received HumanMessage".
  summaryMessage: z.custom<HumanMessage>((value) => HumanMessage.isInstance(value)),
  filePath: z.string().nullable()
})

export type SummarizationEvent = z.infer<typeof SummarizationEventSchema>

const SummarizationStateSchema = z.object({
  _summarizationSessionId: z.string().optional(),
  _summarizationEvent: SummarizationEventSchema.optional(),
  [SUMMARIZATION_STATE_OWNER_KEY]: z.string().optional()
})

function isSummaryMessage(message: BaseMessage): boolean {
  return (
    HumanMessage.isInstance(message) && message.additional_kwargs?.lc_source === "summarization"
  )
}

function isRetryMarker(message: BaseMessage): boolean {
  return (
    HumanMessage.isInstance(message) &&
    message.additional_kwargs?.lc_source === "summarization_retry"
  )
}

function extractSummaryText(content: unknown): string {
  return messageText(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function hasDsmlToolCallMarkers(content: string): boolean {
  const toolCallsPattern = /<\|{1,2}DSML\|{1,2}tool_calls\s*>/i
  if (!toolCallsPattern.test(content)) return false

  return (
    /<\|{1,2}DSML\|{1,2}invoke(?:\s|>)/i.test(content) ||
    /^\s*<\|{1,2}DSML\|{1,2}tool_calls\s*>/i.test(content)
  )
}

/**
 * Detect a DeepSeek DSML tool invocation without rejecting a handoff that
 * merely quotes a DSML example in a fenced Markdown block.
 *
 * DeepSeek V4 uses full-width vertical bars in its native DSML grammar. NFKC
 * normalisation also covers gateways that expose the equivalent ASCII form.
 * A complete closing tag is intentionally not required because a truncated
 * tool invocation is still not a usable continuation handoff.
 */
function isDsmlToolCallOutput(content: string): boolean {
  const normalized = content.trim().normalize("NFKC")
  if (!hasDsmlToolCallMarkers(normalized)) return false

  // A response consisting only of a fenced DSML block is still a tool call,
  // not a prose handoff. Normal prose plus a fenced example remains valid.
  const soleFence = normalized.match(/^```[^\n]*\n?([\s\S]*?)```\s*$/)
  if (soleFence && hasDsmlToolCallMarkers(soleFence[1] ?? "")) return true

  const outsideCompletedFences = normalized.replace(/```[^\n]*\n[\s\S]*?```/g, "")
  return hasDsmlToolCallMarkers(outsideCompletedFences)
}

function hasStructuredSummaryToolCall(message: BaseMessage): boolean {
  if (!AIMessage.isInstance(message)) return false
  if ((message.tool_calls?.length ?? 0) > 0 || (message.invalid_tool_calls?.length ?? 0) > 0) {
    return true
  }

  const rawToolCalls = message.additional_kwargs?.tool_calls
  if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) return true

  if (
    Array.isArray(message.content) &&
    message.content.some((block) => {
      if (!block || typeof block !== "object") return false
      const type = "type" in block && typeof block.type === "string" ? block.type : ""
      return ["tool_call", "tool_use", "function_call"].includes(type)
    })
  ) {
    return true
  }

  const finishReason = message.response_metadata?.finish_reason
  return finishReason === "tool_calls" || finishReason === "tool_use"
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""

  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block]
      if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
        return [block.text]
      }
      return []
    })
    .join("\n")
    .trim()
}

function userRequestText(message: BaseMessage): string {
  const visibleContent = message.additional_kwargs?.[VISIBLE_USER_MESSAGE_KEY]
  if (typeof visibleContent === "string" && visibleContent.trim()) {
    return visibleContent.trim()
  }
  return messageText(message.content)
}

function summaryMediaPlaceholder(block: unknown): string | null {
  if (!block || typeof block !== "object") return null
  const record = block as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : ""

  switch (type) {
    case "image":
    case "image_url":
    case "input_image":
      return "[image]"
    case "audio":
    case "input_audio":
      return "[audio]"
    case "video":
      return "[video]"
    case "document":
      return "[document]"
    case "file":
      // Text-backed MCP resources remain useful structured context. Strip only
      // binary/URL/file-id payloads that would resend media to the summarizer.
      return record.source_type === "text" && typeof record.text === "string" ? null : "[file]"
    default:
      return null
  }
}

/**
 * Remove media payloads only from the transient summary-model request.
 *
 * This mirrors Claude Code/OpenCode compaction and LangChain's own compact
 * content rendering: preserve roles, text, tool calls, and provider-specific
 * non-media blocks, but replace images/audio/video/binary files with bounded
 * text markers. Checkpoint and archive source messages are never mutated.
 */
function sanitizeSummaryMedia(message: BaseMessage): BaseMessage {
  if (!Array.isArray(message.content)) return message

  let changed = false
  const content = message.content.map((block) => {
    const placeholder = summaryMediaPlaceholder(block)
    if (!placeholder) return block
    changed = true
    return { type: "text" as const, text: placeholder }
  })
  if (!changed) return message

  const clone = Object.assign(Object.create(Object.getPrototypeOf(message)), message) as BaseMessage
  clone.content = content
  return clone
}

function historyArchiveBlockText(block: unknown): string {
  if (typeof block === "string") return block
  if (!block || typeof block !== "object") return ""

  const record = block as Record<string, unknown>
  if (record.type === "file" && record.source_type === "text" && typeof record.text === "string") {
    return `[file]\n${record.text}\n[/file]`
  }

  const placeholder = summaryMediaPlaceholder(block)
  if (placeholder) return placeholder
  if (typeof record.text === "string") return record.text
  return typeof record.type === "string" ? `[${record.type}]` : ""
}

/**
 * Render structured content into the local text transcript without persisting
 * media payloads. Text-backed MCP resources remain recoverable; binary, URL,
 * image, and audio blocks stay bounded placeholders. The checkpoint messages
 * themselves remain untouched.
 */
function prepareHistoryArchiveMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(message)),
      message
    ) as BaseMessage
    clone.content = message.content.map(historyArchiveBlockText).filter(Boolean).join("\n")
    return clone
  })
}

function isRealUserMessage(message: BaseMessage): boolean {
  return (
    HumanMessage.isInstance(message) &&
    !isSummaryMessage(message) &&
    !isRetryMarker(message) &&
    message.additional_kwargs?.[INTERNAL_COORDINATOR_NOTIFICATION_KEY] !== true &&
    !isWorkflowNotificationPrompt(message.content)
  )
}

function findLatestUserRequest(messages: BaseMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRealUserMessage(message)) continue
    const content = userRequestText(message)
    if (content) {
      return truncateUserRequestAnchor(
        content,
        LATEST_USER_REQUEST_MAX_CHARS,
        LATEST_USER_REQUEST_TRUNCATION_MARKER
      )
    }
  }
  return null
}

function truncateUserRequestAnchor(content: string, maxChars: number, marker: string): string {
  const characters = Array.from(content)
  if (characters.length <= maxChars) return content

  const headLength = Math.floor(maxChars / 2)
  const tailLength = maxChars - headLength
  return `${characters.slice(0, headLength).join("")}${marker}${characters.slice(-tailLength).join("")}`
}

function truncateInitialUserRequest(content: string): string {
  return truncateUserRequestAnchor(
    content,
    INITIAL_USER_REQUEST_MAX_CHARS,
    INITIAL_USER_REQUEST_TRUNCATION_MARKER
  )
}

function findInitialUserRequest(
  messages: BaseMessage[],
  originalMessages: BaseMessage[] = messages
): string | null {
  for (const message of messages) {
    if (!isSummaryMessage(message)) continue
    const existing = message.additional_kwargs?.[INITIAL_USER_REQUEST_KEY]
    if (typeof existing === "string" && existing.trim()) return existing.trim()
  }

  // Native/legacy summary messages predate cmb_initial_user_request. Their
  // effective view starts at the summarized tail, but LangGraph still retains
  // the original state.messages. Recover the true first request from that raw
  // history instead of promoting the first post-cutoff correction.
  for (const message of originalMessages) {
    if (!isRealUserMessage(message)) continue
    const content = userRequestText(message)
    if (content) return truncateInitialUserRequest(content)
  }
  return null
}

function prepareStructuredSummaryMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!isSummaryMessage(message)) return message
    const previousContent = messageText(message.content)
    const summaryBody = previousContent.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)?.[1]?.trim()
    return new HumanMessage({
      content: `<previous-summary>\n${summaryBody || previousContent}\n</previous-summary>`,
      additional_kwargs: { lc_source: "summarization_context" }
    })
  })
}

/**
 * Normalise only the transient summary-model request. Raw checkpoint history
 * remains untouched, and the separate conversation-history archive keeps its
 * own text-oriented representation.
 */
function prepareSummaryModelRequest(messages: BaseMessage[]): BaseMessage[] {
  return repairModelRequestToolCallParity(
    sanitizeModelRequestMessages(messages.map(sanitizeSummaryMedia))
  )
}

function escapeSummaryXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function quoteSummaryXmlAttribute(value: unknown): string {
  return `"${escapeSummaryXmlText(String(value ?? ""))
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")}"`
}

function stringifySummaryToolArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return JSON.stringify(String(value ?? ""))
  }
}

function summaryMessageType(message: BaseMessage): string {
  if (HumanMessage.isInstance(message)) return "human"
  if (AIMessage.isInstance(message)) return "ai"
  if (SystemMessage.isInstance(message)) return "system"
  if (ToolMessage.isInstance(message)) return "tool"
  return message.getType()
}

function renderSummaryContentXml(content: BaseMessage["content"]): string {
  if (typeof content === "string") return escapeSummaryXmlText(content)
  if (!Array.isArray(content)) return ""

  return content
    .flatMap((block) => {
      if (typeof block === "string") return block ? [escapeSummaryXmlText(block)] : []
      if (!block || typeof block !== "object") return []

      const record = block as Record<string, unknown>
      const type = typeof record.type === "string" ? record.type : ""
      if (type === "reasoning" && typeof record.reasoning === "string") {
        return [`<reasoning>${escapeSummaryXmlText(record.reasoning)}</reasoning>`]
      }
      if (type === "file" && record.source_type === "text" && typeof record.text === "string") {
        return [`<file>${escapeSummaryXmlText(record.text)}</file>`]
      }
      if (type === "server_tool_call") {
        return [
          `<server_tool_call id=${quoteSummaryXmlAttribute(record.id)} name=${quoteSummaryXmlAttribute(record.name)}>${escapeSummaryXmlText(stringifySummaryToolArgs(record.args).slice(0, 500))}</server_tool_call>`
        ]
      }
      if (type === "server_tool_result") {
        return [
          `<server_tool_result tool_call_id=${quoteSummaryXmlAttribute(record.tool_call_id)} status=${quoteSummaryXmlAttribute(record.status)}>${escapeSummaryXmlText(stringifySummaryToolArgs(record.output).slice(0, 500))}</server_tool_result>`
        ]
      }

      const text = historyArchiveBlockText(block)
      return text ? [escapeSummaryXmlText(text)] : []
    })
    .join(" ")
}

/**
 * Render a provider-neutral transcript for the summarizer.
 *
 * DeepAgents Python deliberately serializes message/tool structure into XML
 * instead of replaying native provider tool-call history. This retains roles,
 * tool names, call ids, arguments, and results while avoiding a second tool
 * protocol negotiation with custom OpenAI-compatible gateways.
 */
function renderMessagesAsSummaryXml(messages: BaseMessage[]): string {
  return messages
    .map((message) => {
      const attributes = [`type=${quoteSummaryXmlAttribute(summaryMessageType(message))}`]
      if (message.name) attributes.push(`name=${quoteSummaryXmlAttribute(message.name)}`)
      if (ToolMessage.isInstance(message)) {
        attributes.push(`tool_call_id=${quoteSummaryXmlAttribute(message.tool_call_id)}`)
      }

      if (
        HumanMessage.isInstance(message) &&
        message.additional_kwargs?.lc_source === "summarization_context" &&
        typeof message.content === "string"
      ) {
        const previousSummary =
          message.content.match(/<previous-summary>\s*([\s\S]*?)\s*<\/previous-summary>/i)?.[1] ??
          message.content
        return `<message ${attributes.join(" ")}><previous-summary>${escapeSummaryXmlText(previousSummary)}</previous-summary></message>`
      }

      const content = renderSummaryContentXml(message.content)
      const toolCalls = AIMessage.isInstance(message) ? (message.tool_calls ?? []) : []
      const functionCall =
        AIMessage.isInstance(message) && toolCalls.length === 0
          ? message.additional_kwargs?.function_call
          : undefined
      if (toolCalls.length === 0 && (!functionCall || typeof functionCall !== "object")) {
        return `<message ${attributes.join(" ")}>${content}</message>`
      }

      const children: string[] = []
      if (content) children.push(`  <content>${content}</content>`)
      for (const toolCall of toolCalls) {
        children.push(
          `  <tool_call id=${quoteSummaryXmlAttribute(toolCall.id)} name=${quoteSummaryXmlAttribute(toolCall.name)}>${escapeSummaryXmlText(stringifySummaryToolArgs(toolCall.args))}</tool_call>`
        )
      }
      if (functionCall && typeof functionCall === "object") {
        const record = functionCall as unknown as Record<string, unknown>
        children.push(
          `  <function_call name=${quoteSummaryXmlAttribute(record.name)}>${escapeSummaryXmlText(String(record.arguments ?? "{}"))}</function_call>`
        )
      }
      return [`<message ${attributes.join(" ")}>`, ...children, "</message>"].join("\n")
    })
    .join("\n")
}

function renderSummaryTranscript(messages: BaseMessage[]): string {
  return renderMessagesAsSummaryXml(
    prepareSummaryModelRequest(prepareStructuredSummaryMessages(messages))
  )
}

function buildSummaryInstruction(
  summaryPrompt: string,
  initialUserRequest: string | null,
  latestUserRequest: string | null,
  targetSummaryTokens?: number,
  conversationTranscript?: string
): string {
  const wrappedTranscript =
    conversationTranscript === undefined
      ? undefined
      : `<messages>\n${conversationTranscript}\n</messages>`
  const resolvedPrompt =
    wrappedTranscript === undefined
      ? summaryPrompt.replace(
          "{conversation}",
          "The conversation is provided as the preceding structured messages."
        )
      : summaryPrompt.includes("{conversation}")
        ? summaryPrompt.replace("{conversation}", wrappedTranscript)
        : `${wrappedTranscript}\n\n${summaryPrompt.replace(
            "from the structured conversation messages above",
            "from the XML conversation transcript above"
          )}`
  const initialAnchor = initialUserRequest
    ? `The initial real user request is repeated below as a bounded historical anchor. Preserve its task and project identity. If later user requests correct or replace any detail, the later request takes precedence. Do not treat this anchor as a new request.\n\n<initial-user-request>\n${initialUserRequest}\n</initial-user-request>`
    : null
  const latestAnchor = latestUserRequest
    ? `The latest real user request is repeated below as a deterministic anchor. Preserve its intent exactly and do not treat it as a new request.\n\n<latest-user-request>\n${latestUserRequest}\n</latest-user-request>`
    : null
  const sizeConstraint =
    typeof targetSummaryTokens === "number" && targetSummaryTokens > 0
      ? `The previous whole-conversation handoff is still too large for the outer model request. Rewrite it to no more than approximately ${targetSummaryTokens} tokens. Preserve the highest-value continuation facts, exact paths, commands, errors, constraints, decisions, and next steps. Return only the shortened handoff.`
      : null
  return [resolvedPrompt, initialAnchor, latestAnchor, sizeConstraint].filter(Boolean).join("\n\n")
}

function summaryQualityIssues(response: BaseMessage, summary: string): string[] {
  // Match the established compaction behavior: a final-text handoff is usable
  // when it is non-empty. A hard character floor rejects concise but complete
  // summaries and turns an otherwise recoverable compaction into a failed turn.
  const issues: string[] = []
  if (!summary) issues.push(EMPTY_SUMMARY_QUALITY_ISSUE)
  if (hasStructuredSummaryToolCall(response)) issues.push(TOOL_CALL_SUMMARY_QUALITY_ISSUE)
  if (summary && isDsmlToolCallOutput(summary)) issues.push(DSML_SUMMARY_QUALITY_ISSUE)
  return issues
}

function buildSummaryQualityCorrection(issues: string[]): string {
  const emptyContentRetry = issues.includes(EMPTY_SUMMARY_QUALITY_ISSUE)
  const toolCallRetry = issues.some(
    (issue) => issue === TOOL_CALL_SUMMARY_QUALITY_ISSUE || issue === DSML_SUMMARY_QUALITY_ISSUE
  )
  if (toolCallRetry) {
    return `The previous response attempted or imitated a tool call (${issues.join(", ")}). Do not call, request, or imitate tools. Return the complete continuation handoff only as final text.`
  }
  if (emptyContentRetry) {
    return `The previous response did not contain a valid final-text handoff (${issues.join(", ")}). Return the complete handoff in the final content field, not as reasoning-only output. Follow the requested structure and return only the corrected handoff.`
  }
  return `Your previous handoff was incomplete (${issues.join(", ")}). Regenerate it with concrete continuation state. Follow the requested structure and return only the corrected handoff.`
}

function groupMessagesByApiRound(messages: BaseMessage[]): BaseMessage[][] {
  const groups: BaseMessage[][] = []
  let current: BaseMessage[] = []

  for (const message of messages) {
    if (AIMessage.isInstance(message) && current.length > 0) {
      groups.push(current)
      current = [message]
    } else {
      current.push(message)
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Claude Code-style overflow recovery: remove oldest complete API rounds only
 * after the model has rejected the complete summary input.
 */
function truncateOldestRoundsForRetry(
  messages: BaseMessage[],
  retryTargetTokens: number,
  fitsRequest?: (messages: BaseMessage[]) => boolean
): BaseMessage[] | null {
  const withoutMarker = messages.filter((message, index) => index !== 0 || !isRetryMarker(message))
  // Consecutive user/steering messages have no AI/tool-call pairing to
  // preserve. Treat each HumanMessage as a safe retry boundary so a provider
  // overflow can actually shrink this otherwise single-group input. Mixed
  // histories must continue to use complete API rounds.
  const groups = withoutMarker.every(HumanMessage.isInstance)
    ? withoutMarker.map((message) => [message])
    : groupMessagesByApiRound(withoutMarker)
  if (groups.length <= 1) return null

  let groupsToDrop = Math.max(1, Math.floor(groups.length * 0.2))
  let upper = groups.length - 1
  // Suffix sizes decrease monotonically. Avoid repeatedly serializing a
  // multi-megabyte conversation once for every dropped round.
  while (groupsToDrop < upper) {
    const middle = Math.floor((groupsToDrop + upper) / 2)
    const remaining = groups.slice(middle).flat()
    if (
      countTokensApproximately(remaining) <= retryTargetTokens &&
      (!fitsRequest || fitsRequest(remaining))
    ) {
      upper = middle
    } else {
      groupsToDrop = middle + 1
    }
  }

  return [
    new HumanMessage({
      content: COMPACTION_RETRY_MARKER,
      additional_kwargs: { lc_source: "summarization_retry" }
    }),
    ...groups.slice(groupsToDrop).flat()
  ]
}

function computeSummarizationDefaults(resolvedModel: BaseChatModel): {
  trigger: ContextSize
  keep: ContextSize
  truncateArgsSettings: TruncateArgsSettings
} {
  const hasProfile =
    resolvedModel.profile &&
    typeof resolvedModel.profile === "object" &&
    "maxInputTokens" in resolvedModel.profile &&
    typeof resolvedModel.profile.maxInputTokens === "number"

  return hasProfile
    ? {
        trigger: PROFILE_TRIGGER,
        keep: PROFILE_KEEP,
        truncateArgsSettings: PROFILE_TRUNCATE_ARGS
      }
    : {
        trigger: FALLBACK_TRIGGER,
        keep: FALLBACK_KEEP,
        truncateArgsSettings: FALLBACK_TRUNCATE_ARGS
      }
}

/**
 * CmbCowork-owned fork of DeepAgents summarization middleware.
 *
 * It intentionally preserves DeepAgents' state/offload/cutoff behavior. The only
 * semantic changes are provider-neutral XML full-history summarization,
 * complete-round overflow retries (with a last-resort oversized-tool-result
 * compaction), bounded invalid-handoff retries, and a no-text fallback model.
 */
export function createCmbSummarizationMiddleware(options: CmbSummarizationMiddlewareOptions) {
  const {
    model,
    fallbackModel,
    overflowModel,
    summaryMaxOutputTokens = 0,
    overflowMaxOutputTokens = summaryMaxOutputTokens,
    backend,
    summaryPrompt = DEFAULT_SUMMARY_PROMPT,
    trimTokensToSummarize = DEFAULT_OVERFLOW_RETRY_TARGET,
    maxInputTokens: configuredMaxInputTokens,
    postCompactionInputBudgetTokens,
    historyPathPrefix = "/conversation_history",
    legacyHistoryPathPrefix,
    stateOwnerConfigKey
  } = options

  let trigger = options.trigger
  let keep: ContextSize = options.keep ?? {
    type: "messages",
    value: DEFAULT_MESSAGES_TO_KEEP
  }
  let truncateArgsSettings = options.truncateArgsSettings
  let defaultsComputed = trigger != null
  let truncateTrigger = truncateArgsSettings?.trigger
  let truncateKeep: ContextSize = truncateArgsSettings?.keep ?? {
    type: "messages",
    value: 20
  }
  let maxArgLength = truncateArgsSettings?.maxLength ?? 2_000
  let truncationText = truncateArgsSettings?.truncationText ?? "...(argument truncated)"
  let sessionId: string | null = null
  let tokenEstimationMultiplier = 1
  let cachedModel: BaseChatModel | undefined
  let cachedFallbackModel: BaseChatModel | undefined
  function applyModelDefaults(resolvedModel: BaseChatModel): void {
    if (defaultsComputed) return
    defaultsComputed = true
    const defaults = computeSummarizationDefaults(resolvedModel)
    trigger = defaults.trigger
    keep = options.keep ?? defaults.keep
    if (!options.truncateArgsSettings) {
      truncateArgsSettings = defaults.truncateArgsSettings
      truncateTrigger = defaults.truncateArgsSettings.trigger
      truncateKeep = defaults.truncateArgsSettings.keep ?? { type: "messages", value: 20 }
      maxArgLength = defaults.truncateArgsSettings.maxLength ?? 2_000
      truncationText = defaults.truncateArgsSettings.truncationText ?? "...(argument truncated)"
    }
  }

  function getBackend(state: unknown): BackendProtocol {
    return typeof backend === "function" ? (backend({ state }) as BackendProtocol) : backend
  }

  function getStateOwner(request: {
    runtime?: { configurable?: Record<string, unknown> }
  }): string | undefined {
    if (!stateOwnerConfigKey) return undefined
    const value = request.runtime?.configurable?.[stateOwnerConfigKey]
    return typeof value === "string" && value.trim() ? value.trim() : undefined
  }

  function stateBelongsToOwner(state: Record<string, unknown>, owner: string | undefined): boolean {
    return !owner || state[SUMMARIZATION_STATE_OWNER_KEY] === owner
  }

  function getValidSummarizationEvent(
    state: Record<string, unknown>,
    owner: string | undefined
  ): SummarizationEvent | undefined {
    if (!stateBelongsToOwner(state, owner) || state._summarizationEvent == null) return undefined

    const parsed = SummarizationEventSchema.safeParse(state._summarizationEvent)
    if (
      !parsed.success ||
      !Number.isInteger(parsed.data.cutoffIndex) ||
      parsed.data.cutoffIndex < 0
    ) {
      console.warn(
        "[SummarizationMiddleware] Ignoring malformed _summarizationEvent and rebuilding from raw messages."
      )
      return undefined
    }
    return parsed.data
  }

  function getSessionId(
    state: Record<string, unknown>,
    owner?: string,
    initialOwnerSessionId?: string
  ): string {
    if (owner) {
      if (
        stateBelongsToOwner(state, owner) &&
        typeof state._summarizationSessionId === "string" &&
        state._summarizationSessionId
      ) {
        return state._summarizationSessionId
      }
      if (initialOwnerSessionId) return initialOwnerSessionId
      return `session_${crypto.randomUUID().substring(0, 8)}`
    }
    if (state._summarizationSessionId) return state._summarizationSessionId as string
    sessionId ??= `session_${crypto.randomUUID().substring(0, 8)}`
    return sessionId
  }

  function getHistoryPath(
    state: Record<string, unknown>,
    owner?: string,
    initialOwnerSessionId?: string
  ): string {
    return `${historyPathPrefix}/${getSessionId(state, owner, initialOwnerSessionId)}.md`
  }

  function getLegacyHistoryPath(
    state: Record<string, unknown>,
    owner?: string,
    initialOwnerSessionId?: string
  ): string | null {
    if (!legacyHistoryPathPrefix || legacyHistoryPathPrefix === historyPathPrefix) return null
    return `${legacyHistoryPathPrefix}/${getSessionId(state, owner, initialOwnerSessionId)}.md`
  }

  async function getChatModel(): Promise<BaseChatModel> {
    if (cachedModel) return cachedModel
    cachedModel = typeof model === "string" ? await initChatModel(model) : (model as BaseChatModel)
    return cachedModel
  }

  async function getFallbackChatModel(): Promise<BaseChatModel | undefined> {
    if (!fallbackModel) return undefined
    if (cachedFallbackModel) return cachedFallbackModel
    cachedFallbackModel =
      typeof fallbackModel === "string"
        ? await initChatModel(fallbackModel)
        : (fallbackModel as BaseChatModel)
    return cachedFallbackModel
  }

  function getMaxInputTokens(resolvedModel: BaseChatModel): number | undefined {
    if (typeof configuredMaxInputTokens === "number" && configuredMaxInputTokens > 0) {
      return configuredMaxInputTokens
    }
    const profile = resolvedModel.profile
    return profile &&
      typeof profile === "object" &&
      "maxInputTokens" in profile &&
      typeof profile.maxInputTokens === "number"
      ? profile.maxInputTokens
      : undefined
  }

  function shouldSummarize(
    messages: BaseMessage[],
    totalTokens: number,
    maxInputTokens?: number
  ): boolean {
    if (!trigger) return false
    const adjustedTokens = totalTokens * tokenEstimationMultiplier
    for (const item of Array.isArray(trigger) ? trigger : [trigger]) {
      if (item.type === "messages" && messages.length >= item.value) return true
      if (item.type === "tokens" && adjustedTokens >= item.value) return true
      if (
        item.type === "fraction" &&
        maxInputTokens &&
        adjustedTokens >= Math.floor(maxInputTokens * item.value)
      ) {
        return true
      }
    }
    return false
  }

  function findSafeCutoffPoint(messages: BaseMessage[], cutoffIndex: number): number {
    if (cutoffIndex >= messages.length || !ToolMessage.isInstance(messages[cutoffIndex])) {
      return cutoffIndex
    }

    let forwardIndex = cutoffIndex
    while (forwardIndex < messages.length && ToolMessage.isInstance(messages[forwardIndex])) {
      forwardIndex += 1
    }

    const toolCallIds = new Set<string>()
    for (let index = cutoffIndex; index < forwardIndex; index += 1) {
      const toolMessage = messages[index] as ToolMessage
      if (toolMessage.tool_call_id) toolCallIds.add(toolMessage.tool_call_id)
    }

    let backwardIndex: number | null = null
    for (let index = cutoffIndex - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!AIMessage.isInstance(message) || !message.tool_calls) continue
      const aiToolCallIds = new Set(
        message.tool_calls.map((call) => call.id).filter((id): id is string => id != null)
      )
      if ([...toolCallIds].some((id) => aiToolCallIds.has(id))) {
        backwardIndex = index
        break
      }
    }

    if (backwardIndex == null) return forwardIndex
    const backwardDistance = cutoffIndex - backwardIndex
    return backwardDistance > cutoffIndex / 2 && cutoffIndex > 2 ? forwardIndex : backwardIndex
  }

  function determineCutoffIndex(messages: BaseMessage[], maxInputTokens?: number): number {
    let rawCutoff = 0
    if (keep.type === "messages") {
      if (messages.length <= keep.value) return 0
      rawCutoff = messages.length - keep.value
    } else {
      const targetTokenCount =
        keep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * keep.value)
          : keep.value
      let tokensKept = 0
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const messageTokens = countTokensApproximately([messages[index]])
        if (tokensKept + messageTokens > targetTokenCount) {
          rawCutoff = index + 1
          break
        }
        tokensKept += messageTokens
      }
    }
    return findSafeCutoffPoint(messages, rawCutoff)
  }

  function shouldTruncateArgs(
    messages: BaseMessage[],
    totalTokens: number,
    maxInputTokens?: number
  ): boolean {
    if (!truncateTrigger) return false
    const adjustedTokens = totalTokens * tokenEstimationMultiplier
    if (truncateTrigger.type === "messages") return messages.length >= truncateTrigger.value
    if (truncateTrigger.type === "tokens") return adjustedTokens >= truncateTrigger.value
    return Boolean(
      maxInputTokens && adjustedTokens >= Math.floor(maxInputTokens * truncateTrigger.value)
    )
  }

  function determineTruncateCutoffIndex(messages: BaseMessage[], maxInputTokens?: number): number {
    let rawCutoff = 0
    if (truncateKeep.type === "messages") {
      if (messages.length <= truncateKeep.value) return messages.length
      rawCutoff = messages.length - truncateKeep.value
    } else {
      const targetTokenCount =
        truncateKeep.type === "fraction" && maxInputTokens
          ? Math.floor(maxInputTokens * truncateKeep.value)
          : truncateKeep.value
      let tokensKept = 0
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const messageTokens = countTokensApproximately([messages[index]])
        if (tokensKept + messageTokens > targetTokenCount) {
          rawCutoff = index + 1
          break
        }
        tokensKept += messageTokens
      }
    }
    return findSafeCutoffPoint(messages, rawCutoff)
  }

  function countTotalTokens(
    messages: BaseMessage[],
    systemMessage?: SystemMessage | unknown,
    tools?: (ServerTool | ClientTool)[] | unknown[]
  ): number {
    const countedMessages =
      systemMessage && SystemMessage.isInstance(systemMessage)
        ? [systemMessage, ...messages]
        : messages
    const toolsArray =
      tools && Array.isArray(tools) && tools.length > 0
        ? (tools as Array<Record<string, unknown>>)
        : null
    return countTokensApproximately(countedMessages, toolsArray)
  }

  function reportedUsageTokens(message: AIMessage): { total: number; input: number | null } | null {
    const responseMetadata = message.response_metadata as Record<string, unknown> | undefined
    const candidates = [
      message.usage_metadata,
      responseMetadata?.token_usage,
      responseMetadata?.usage,
      message.additional_kwargs?.usage_metadata
    ]

    const finiteNonNegative = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue
      const usage = candidate as Record<string, unknown>
      const total = finiteNonNegative(usage.total_tokens ?? usage.totalTokens)

      const input = finiteNonNegative(
        usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens
      )
      const output = finiteNonNegative(
        usage.output_tokens ??
          usage.outputTokens ??
          usage.completion_tokens ??
          usage.completionTokens
      )
      if (total != null && total > 0) return { total, input }
      if (input != null && input > 0) return { total: input + (output ?? 0), input }
    }
    return null
  }

  /**
   * Anchor proactive compaction to the latest provider-reported context size,
   * then estimate only messages appended after that response. The full local
   * estimate remains a fallback for providers that omit usage metadata and a
   * guard for changed system prompts or tool schemas.
   */
  function countTokensForTrigger(
    messages: BaseMessage[],
    approximateTotal: number
  ): {
    tokens: number
    reportedTotalTokens: number | null
    reportedInputTokens: number | null
    appendedEstimatedTokens: number
  } {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!AIMessage.isInstance(message)) continue
      const reportedTokens = reportedUsageTokens(message)
      if (reportedTokens == null) continue
      const appendedTokens = countTokensApproximately(messages.slice(index + 1))
      return {
        tokens: Math.max(approximateTotal, Math.ceil(reportedTokens.total + appendedTokens)),
        reportedTotalTokens: reportedTokens.total,
        reportedInputTokens: reportedTokens.input,
        appendedEstimatedTokens: appendedTokens
      }
    }
    return {
      tokens: approximateTotal,
      reportedTotalTokens: null,
      reportedInputTokens: null,
      appendedEstimatedTokens: 0
    }
  }

  function compactToolResults(
    messages: BaseMessage[],
    maxInputTokens: number,
    systemMessage?: SystemMessage | unknown,
    tools?: (ServerTool | ClientTool)[] | unknown[]
  ): { messages: BaseMessage[]; modified: boolean } {
    const toolMessageIndexes = messages.flatMap((message, index) =>
      ToolMessage.isInstance(message) ? [index] : []
    )
    if (toolMessageIndexes.length === 0) return { messages, modified: false }

    const overheadTokens = countTotalTokens(
      messages.filter((message) => !ToolMessage.isInstance(message)),
      systemMessage,
      tools
    )
    const adjustedMax = maxInputTokens / tokenEstimationMultiplier
    const budgetForTools = Math.max(adjustedMax * 0.7 - overheadTokens, 1_000)
    const perToolBudgetChars = Math.floor(budgetForTools / toolMessageIndexes.length) * 4
    const result = [...messages]
    let modified = false

    for (const index of toolMessageIndexes) {
      const message = messages[index] as ToolMessage
      const content =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      if (content.length <= perToolBudgetChars) continue
      result[index] = new ToolMessage({
        content: `${content.substring(0, perToolBudgetChars)}\n...(result truncated)`,
        tool_call_id: message.tool_call_id,
        name: message.name
      })
      modified = true
    }
    return { messages: result, modified }
  }

  function truncateArgs(
    messages: BaseMessage[],
    totalTokens: number,
    maxInputTokens?: number
  ): { messages: BaseMessage[]; modified: boolean } {
    if (!shouldTruncateArgs(messages, totalTokens, maxInputTokens)) {
      return { messages, modified: false }
    }
    const cutoffIndex = determineTruncateCutoffIndex(messages, maxInputTokens)
    if (cutoffIndex >= messages.length) return { messages, modified: false }

    let modified = false
    const truncatedMessages = messages.map((message, index) => {
      if (index >= cutoffIndex || !AIMessage.isInstance(message) || !message.tool_calls) {
        return message
      }
      let messageModified = false
      const toolCalls = message.tool_calls.map((toolCall) => {
        const args = toolCall.args || {}
        const truncatedArgs: Record<string, unknown> = {}
        let toolModified = false
        for (const [key, value] of Object.entries(args)) {
          if (
            typeof value === "string" &&
            value.length > maxArgLength &&
            (toolCall.name === "write_file" || toolCall.name === "edit_file")
          ) {
            truncatedArgs[key] = value.substring(0, 20) + truncationText
            toolModified = true
          } else {
            truncatedArgs[key] = value
          }
        }
        messageModified ||= toolModified
        return toolModified ? { ...toolCall, args: truncatedArgs } : toolCall
      })
      if (!messageModified) return message
      modified = true
      return new AIMessage({
        content: message.content,
        tool_calls: toolCalls,
        additional_kwargs: message.additional_kwargs
      })
    })
    return { messages: truncatedMessages, modified }
  }

  async function offloadToBackend(
    resolvedBackend: BackendProtocol,
    messages: BaseMessage[],
    state: Record<string, unknown>,
    owner?: string,
    initialOwnerSessionId?: string
  ): Promise<string | null> {
    const filePath = getHistoryPath(state, owner, initialOwnerSessionId)
    const legacyFilePath = getLegacyHistoryPath(state, owner, initialOwnerSessionId)
    const filteredMessages = messages.filter((message) => !isSummaryMessage(message))
    const newSection = `## Summarized at ${new Date().toISOString()}\n\n${renderMessagesAsSummaryXml(prepareHistoryArchiveMessages(filteredMessages))}\n\n`
    const sectionBytes = new TextEncoder().encode(newSection)

    try {
      const internalBackend = resolvedBackend as InternalArtifactBackend
      const supportsInternalAppend = Boolean(
        internalBackend.appendInternalArtifact && internalBackend.writeInternalArtifact
      )
      let managedArtifactExists: boolean | null = null
      if (supportsInternalAppend && internalBackend.internalArtifactExists) {
        try {
          managedArtifactExists = await internalBackend.internalArtifactExists(filePath)
        } catch {
          // Unknown internal backends retain the generic download-based path.
        }
      }

      let existingBytes: Uint8Array | null = null
      let importedLegacyHistory = false
      if (managedArtifactExists == null && resolvedBackend.downloadFiles) {
        try {
          const responses = await resolvedBackend.downloadFiles([filePath])
          const response = responses[0]
          if (response?.content && !response.error) existingBytes = response.content
        } catch {
          // A missing history file is expected on first compaction.
        }
      }
      if (managedArtifactExists !== true && !existingBytes && legacyFilePath) {
        if (resolvedBackend.downloadFiles) {
          try {
            const responses = await resolvedBackend.downloadFiles([legacyFilePath])
            const response = responses[0]
            if (response?.content && !response.error) {
              existingBytes = response.content
              importedLegacyHistory = true
            }
          } catch {
            // A missing legacy file is expected for conversations created after migration.
          }
        }
      }

      let result: { error?: string; path?: string }
      if (internalBackend.appendInternalArtifact && internalBackend.writeInternalArtifact) {
        if (existingBytes && importedLegacyHistory) {
          const existingContent = new TextDecoder().decode(existingBytes)
          result = await internalBackend.writeInternalArtifact(
            filePath,
            existingContent + newSection
          )
        } else {
          result = await internalBackend.appendInternalArtifact(filePath, newSection)
        }
      } else if (existingBytes && resolvedBackend.uploadFiles) {
        const combined = new Uint8Array(existingBytes.byteLength + sectionBytes.byteLength)
        combined.set(existingBytes, 0)
        combined.set(sectionBytes, existingBytes.byteLength)
        const uploadResults = await resolvedBackend.uploadFiles([[filePath, combined]])
        result = uploadResults[0]?.error ? { error: uploadResults[0].error } : { path: filePath }
      } else if (existingBytes && importedLegacyHistory) {
        const existingContent = new TextDecoder().decode(existingBytes)
        result = await resolvedBackend.write(filePath, existingContent + newSection)
      } else if (!existingBytes) {
        result = await resolvedBackend.write(filePath, newSection)
      } else {
        const existingContent = new TextDecoder().decode(existingBytes)
        result = await resolvedBackend.edit(filePath, existingContent, existingContent + newSection)
      }

      if (result.error) {
        console.warn(`Failed to offload conversation history to ${filePath}: ${result.error}`)
        return null
      }
      return filePath
    } catch (error) {
      console.warn(`Exception offloading conversation history to ${filePath}:`, error)
      return null
    }
  }

  async function createSummary(
    messages: BaseMessage[],
    chatModel: BaseChatModel,
    fallbackChatModel: BaseChatModel | undefined,
    attemptBudget: SummaryAttemptBudget,
    initialUserRequest: string | null,
    latestUserRequest: string | null,
    signal?: AbortSignal,
    targetSummaryTokens?: number,
    maxAdditionalAttempts?: number
  ): Promise<string> {
    let attemptMessages = messages
    let overflowRetries = 0
    let retryByteBudget: number | undefined
    let observedContextWindow: number | undefined
    let reservedOutputTokens = summaryMaxOutputTokens
    let invalidSummaryAttempts = 0
    let previousQualityIssues: string[] = []
    let activeModel = chatModel
    const attemptLimit =
      typeof maxAdditionalAttempts === "number"
        ? Math.min(MAX_SUMMARY_MODEL_ATTEMPTS, attemptBudget.used + maxAdditionalAttempts)
        : MAX_SUMMARY_MODEL_ATTEMPTS

    for (;;) {
      const conversationTranscript = renderSummaryTranscript(attemptMessages)
      const buildRequest = (transcript: string, compactInstructions = false): BaseMessage[] => [
        new SystemMessage({
          content: SUMMARY_TEXT_ONLY_INSTRUCTION,
          additional_kwargs: { lc_source: "summarization_system" }
        }),
        new HumanMessage({
          content: [
            buildSummaryInstruction(
              compactInstructions
                ? "Summarize this transcript excerpt as a concise continuation handoff. Preserve the goal, constraints, completed work, blockers, exact evidence, and next step. Earlier omitted history remains in the source conversation."
                : summaryPrompt,
              compactInstructions && initialUserRequest
                ? excerptUtf8(
                    initialUserRequest,
                    Math.min(512, Math.floor((retryByteBudget ?? 4_096) / 8))
                  )
                : initialUserRequest,
              compactInstructions && latestUserRequest
                ? excerptUtf8(
                    latestUserRequest,
                    Math.min(512, Math.floor((retryByteBudget ?? 4_096) / 8))
                  )
                : latestUserRequest,
              targetSummaryTokens,
              transcript
            ),
            previousQualityIssues.length > 0
              ? buildSummaryQualityCorrection(previousQualityIssues)
              : null
          ]
            .filter(Boolean)
            .join("\n\n"),
          additional_kwargs: {
            lc_source: "summarization_request",
            cmb_summary_request_format: "xml_text"
          }
        })
      ]
      const summaryMessages =
        retryByteBudget === undefined
          ? buildRequest(conversationTranscript)
          : fitSummaryRequestToBytes(conversationTranscript, retryByteBudget, buildRequest)
      const requestBytes = summaryRequestBytes(summaryMessages)
      try {
        if (attemptBudget.used >= attemptLimit) {
          throw new Error(`Summary model attempt limit reached (${MAX_SUMMARY_MODEL_ATTEMPTS})`)
        }
        signal?.throwIfAborted()
        attemptBudget.used += 1
        attemptBudget.diagnostics?.record("summary_attempt", {
          attempt: attemptBudget.used,
          sourceMessageCount: attemptMessages.length,
          estimatedInputTokens: countTokensApproximately(summaryMessages),
          requestBytes,
          retryByteBudget,
          reservedOutputTokens,
          observedContextWindow
        })
        const response = await activeModel.invoke(summaryMessages, signal ? { signal } : undefined)
        signal?.throwIfAborted()
        const summary = extractSummaryText(response.content)
        const qualityIssues = summaryQualityIssues(response, summary)
        if (qualityIssues.length > 0) {
          invalidSummaryAttempts += 1
          if (
            invalidSummaryAttempts < MAX_SUMMARY_QUALITY_ATTEMPTS &&
            attemptBudget.used < attemptLimit
          ) {
            previousQualityIssues = qualityIssues
            if (!summary && fallbackChatModel && activeModel !== overflowModel)
              activeModel = fallbackChatModel
            continue
          }
          throw new Error(`Summary model returned an invalid handoff: ${qualityIssues.join(", ")}`)
        }
        attemptBudget.diagnostics?.record("summary_completed", {
          attempt: attemptBudget.used,
          summaryChars: summary.length,
          summaryBytes: Buffer.byteLength(summary)
        })
        return summary
      } catch (error) {
        attemptBudget.diagnostics?.record("summary_error", {
          attempt: attemptBudget.used,
          overflow: isCmbContextOverflow(error),
          error: compactionErrorDetails(error)
        })
        if (
          !isCmbContextOverflow(error) ||
          overflowRetries >= MAX_SUMMARY_OVERFLOW_RETRIES ||
          attemptBudget.used >= attemptLimit
        ) {
          throw error
        }
        // Retry from the same transient, provider-safe message shape used by
        // the failed summary request. A malformed/orphan ToolMessage can make
        // an otherwise all-Human history look like one indivisible API round;
        // sanitizing first removes that artificial boundary without mutating
        // checkpoint or archive history.
        const retryMessages = prepareSummaryModelRequest(attemptMessages)
        const beforeMessageCount = attemptMessages.length
        const beforeEstimatedTokens = countTokensApproximately(summaryMessages)
        if (overflowModel) {
          activeModel = overflowModel as BaseChatModel
          reservedOutputTokens = overflowMaxOutputTokens
        }
        const reportedWindow = contextWindowFromError(error)
        if (reportedWindow)
          observedContextWindow = Math.min(observedContextWindow ?? Infinity, reportedWindow)
        retryByteBudget = summaryRetryByteBudget({
          previousRequestBytes: requestBytes,
          configuredInputBudget: trimTokensToSummarize,
          contextWindow: observedContextWindow ?? getMaxInputTokens(activeModel),
          outputTokens: reservedOutputTokens,
          lastAttempt: attemptBudget.used === attemptLimit - 1
        })
        previousQualityIssues = []
        const truncated = truncateOldestRoundsForRetry(
          retryMessages,
          trimTokensToSummarize,
          (messages) =>
            summaryRequestBytes(buildRequest(renderSummaryTranscript(messages))) <= retryByteBudget!
        )
        attemptMessages = truncated ?? retryMessages
        let nextRequest: BaseMessage[]
        try {
          nextRequest = fitSummaryRequestToBytes(
            renderSummaryTranscript(attemptMessages),
            retryByteBudget,
            buildRequest
          )
        } catch (fittingError) {
          attemptBudget.diagnostics?.record("recovery_budget_exhausted", {
            retryByteBudget,
            error: compactionErrorDetails(fittingError)
          })
          throw error
        }
        attemptBudget.diagnostics?.record("summary_retry_trim", {
          attempt: attemptBudget.used,
          strategy: truncated
            ? "oldest_rounds_then_serialized_byte_budget"
            : "serialized_byte_budget",
          beforeMessageCount,
          afterMessageCount: attemptMessages.length,
          beforeEstimatedTokens,
          afterEstimatedTokens: countTokensApproximately(nextRequest),
          beforeRequestBytes: requestBytes,
          afterRequestBytes: summaryRequestBytes(nextRequest),
          retryByteBudget,
          observedContextWindow,
          reservedOutputTokens
        })
        overflowRetries += 1
      }
    }
  }

  function buildSummaryMessage(
    summary: string,
    filePath: string | null,
    initialUserRequest: string | null
  ): HumanMessage {
    const initialAnchor = initialUserRequest
      ? `\n\nThe initial request below is historical context. Later user corrections and the condensed summary take precedence over conflicting details.\n\n<initial-user-request>\n${initialUserRequest}\n</initial-user-request>`
      : ""
    const content = filePath
      ? `You are in the middle of a conversation that has been summarized.

A text transcript of the earlier conversation has been saved to ${filePath} should you need to refer back to it for details. Structured media and binary payloads may be represented by placeholders.
${initialAnchor}

A condensed summary follows:

<summary>
${summary}
</summary>`
      : initialUserRequest
        ? `Here is a summary of the conversation to date.${initialAnchor}\n\n<summary>\n${summary}\n</summary>`
        : `Here is a summary of the conversation to date:\n\n${summary}`
    return new HumanMessage({
      content,
      additional_kwargs: {
        lc_source: "summarization",
        ...(initialUserRequest ? { [INITIAL_USER_REQUEST_KEY]: initialUserRequest } : {})
      }
    })
  }

  function getEffectiveMessages(
    messages: BaseMessage[],
    state: Record<string, unknown>,
    owner?: string
  ): BaseMessage[] {
    const event = getValidSummarizationEvent(state, owner)
    return event ? [event.summaryMessage, ...messages.slice(event.cutoffIndex)] : messages
  }

  async function summarizeMessages(
    messagesToSummarize: BaseMessage[],
    resolvedModel: BaseChatModel,
    fallbackModel: BaseChatModel | undefined,
    attemptBudget: SummaryAttemptBudget,
    state: Record<string, unknown>,
    previousCutoffIndex: number | undefined,
    cutoffIndex: number,
    initialUserRequest: string | null,
    latestUserRequest: string | null,
    signal?: AbortSignal,
    owner?: string,
    initialOwnerSessionId?: string,
    historyMessages: BaseMessage[] = messagesToSummarize
  ): Promise<{
    summary: string
    summaryMessage: HumanMessage
    filePath: string | null
    stateCutoffIndex: number
  }> {
    // Generate a usable handoff before mutating archival history. This prevents
    // a summary-model failure from leaving an orphaned copy; the archive itself
    // remains best-effort if the subsequent outer model call fails.
    const summary = await createSummary(
      messagesToSummarize,
      resolvedModel,
      fallbackModel,
      attemptBudget,
      initialUserRequest,
      latestUserRequest,
      signal
    )
    signal?.throwIfAborted()
    const resolvedBackend = getBackend(state)
    const filePath = await offloadToBackend(
      resolvedBackend,
      historyMessages,
      state,
      owner,
      initialOwnerSessionId
    )
    // Local archival writes are intentionally allowed to finish once started,
    // but a cancellation that arrives during that short window must prevent
    // the outer model handler from running afterward.
    signal?.throwIfAborted()
    if (filePath == null) {
      console.warn(
        "[SummarizationMiddleware] Backend offload failed during summarization. Proceeding with summary generation."
      )
    }
    return {
      summary,
      summaryMessage: buildSummaryMessage(summary, filePath, initialUserRequest),
      filePath,
      stateCutoffIndex:
        previousCutoffIndex != null ? previousCutoffIndex + cutoffIndex - 1 : cutoffIndex
    }
  }

  async function performSummarization(
    request: {
      messages: BaseMessage[]
      state: Record<string, unknown>
      systemMessage?: SystemMessage | unknown
      tools?: (ServerTool | ClientTool)[] | unknown[]
      runtime?: { signal?: AbortSignal; configurable?: Record<string, unknown> }
      [key: string]: unknown
    },
    handler: (request: any) => any,
    truncatedMessages: BaseMessage[],
    resolvedModel: BaseChatModel,
    fallbackModel: BaseChatModel | undefined,
    maxInputTokens: number | undefined,
    owner?: string,
    historySourceMessages: BaseMessage[] = truncatedMessages,
    diagnostics?: CompactionDiagnostics,
    forceRecovery = false
  ): Promise<any> {
    const initialOwnerSessionId =
      owner &&
      (!stateBelongsToOwner(request.state, owner) ||
        typeof request.state._summarizationSessionId !== "string" ||
        !request.state._summarizationSessionId)
        ? `session_${crypto.randomUUID().substring(0, 8)}`
        : undefined
    const previousEvent = getValidSummarizationEvent(request.state, owner)
    let cutoffIndex = determineCutoffIndex(truncatedMessages, maxInputTokens)
    // DeepAgents Python refuses token-based compaction when it cannot preserve
    // any message. CmbCowork intentionally still supports summarizing one
    // oversized raw user/tool message, but a chained cutoff of 1 is different:
    // effective[0] is the synthetic previous summary, so
    // previousCutoff + 1 - 1 would not advance the raw-state cutoff at all.
    // Re-summarizing it cannot evict new history and can otherwise create a
    // compaction loop. A real provider rejection is different: summarize the
    // whole effective input, even if it lies entirely inside the keep budget.
    const advancesStateCutoff = previousEvent == null || cutoffIndex > 1
    if (cutoffIndex <= 0 || !advancesStateCutoff) {
      if (!forceRecovery) {
        try {
          return await handler({ ...request, messages: truncatedMessages })
        } catch (error) {
          if (!isCmbContextOverflow(error)) throw error
        }
      }
      cutoffIndex = truncatedMessages.length
      diagnostics?.record("force_whole_conversation", {
        reason: "provider_overflow_within_keep_budget",
        cutoffIndex
      })
    }

    const messagesToSummarize = truncatedMessages.slice(0, cutoffIndex)
    const preservedMessages = truncatedMessages.slice(cutoffIndex)
    const historyMessagesToSummarize = historySourceMessages.slice(0, cutoffIndex)
    const preservedHistoryMessages = historySourceMessages.slice(cutoffIndex)
    const initialUserRequest = findInitialUserRequest(truncatedMessages, request.messages)
    const latestUserRequest = preservedMessages.some(isRealUserMessage)
      ? null
      : findLatestUserRequest(messagesToSummarize)
    const outerInputBudget =
      typeof postCompactionInputBudgetTokens === "number" && postCompactionInputBudgetTokens > 0
        ? postCompactionInputBudgetTokens
        : null
    const estimateOuterInputTokens = (messages: BaseMessage[]): number =>
      Math.ceil(
        countTotalTokens(messages, request.systemMessage, request.tools) * tokenEstimationMultiplier
      )

    if (preservedMessages.length === 0 && maxInputTokens) {
      const compact = compactToolResults(
        truncatedMessages,
        maxInputTokens,
        request.systemMessage,
        request.tools
      )
      if (compact.modified) {
        try {
          return await handler({ ...request, messages: compact.messages })
        } catch (error) {
          if (!isCmbContextOverflow(error)) throw error
        }
      }
    }

    const summaryAttemptBudget: SummaryAttemptBudget = { used: 0, diagnostics }
    const summaryResult = await summarizeMessages(
      messagesToSummarize,
      resolvedModel,
      fallbackModel,
      summaryAttemptBudget,
      request.state,
      previousEvent?.cutoffIndex,
      cutoffIndex,
      initialUserRequest,
      latestUserRequest,
      request.runtime?.signal,
      owner,
      initialOwnerSessionId,
      historyMessagesToSummarize
    )

    let finalSummaryMessage = summaryResult.summaryMessage
    let finalFilePath = summaryResult.filePath
    let finalStateCutoffIndex = summaryResult.stateCutoffIndex
    let modifiedMessages = [summaryResult.summaryMessage, ...preservedMessages]
    const modifiedTokens = countTotalTokens(modifiedMessages, request.systemMessage, request.tools)
    const estimatedModifiedTokens = Math.ceil(modifiedTokens * tokenEstimationMultiplier)
    let needsWholeConversationRetry =
      outerInputBudget != null && estimatedModifiedTokens > outerInputBudget

    if (!needsWholeConversationRetry) {
      try {
        await handler({ ...request, messages: modifiedMessages })
      } catch (error) {
        if (!isCmbContextOverflow(error)) throw error
        needsWholeConversationRetry = true
        if (maxInputTokens && modifiedTokens > 0) {
          const observedRatio = maxInputTokens / modifiedTokens
          if (observedRatio > tokenEstimationMultiplier) {
            tokenEstimationMultiplier = observedRatio * 1.1
          }
        }
      }
    } else {
      console.warn(
        `[SummarizationMiddleware] Compacted request remains above the outer model input budget (${estimatedModifiedTokens} estimated tokens > ${outerInputBudget}); retrying with a whole-conversation summary before invoking the model.`
      )
    }

    if (needsWholeConversationRetry) {
      const retryResult = await summarizeMessages(
        [...messagesToSummarize, ...preservedMessages],
        resolvedModel,
        fallbackModel,
        summaryAttemptBudget,
        request.state,
        previousEvent?.cutoffIndex,
        truncatedMessages.length,
        initialUserRequest,
        // The retry summarizes the complete effective conversation, so the
        // latest user request is already present as a structured message.
        // Repeating it in the instruction wastes context and, for a very large
        // request, can defeat the overflow compaction applied to that message.
        null,
        request.runtime?.signal,
        owner,
        initialOwnerSessionId,
        // The first successful summary has already archived the summarized
        // head. On the whole-conversation retry, append only the tail that was
        // previously retained; otherwise the historical head is duplicated.
        summaryResult.filePath ? preservedHistoryMessages : historySourceMessages
      )
      // The head may already be durably archived even if this best-effort tail
      // append fails. Never discard that valid recovery pointer because a
      // later write returned null.
      finalFilePath = retryResult.filePath ?? summaryResult.filePath
      finalSummaryMessage = buildSummaryMessage(
        retryResult.summary,
        finalFilePath,
        initialUserRequest
      )
      finalStateCutoffIndex = retryResult.stateCutoffIndex
      modifiedMessages = [finalSummaryMessage]

      const retryEstimatedTokens = estimateOuterInputTokens(modifiedMessages)
      if (outerInputBudget != null && retryEstimatedTokens > outerInputBudget) {
        const fixedInputTokens = estimateOuterInputTokens([
          buildSummaryMessage("", finalFilePath, initialUserRequest)
        ])
        const targetSummaryTokens = Math.floor(
          (outerInputBudget - fixedInputTokens) / tokenEstimationMultiplier
        )
        if (targetSummaryTokens <= 0) {
          throw new Error(
            `Compacted request cannot fit the outer model input budget: fixed system, tools, and handoff wrapper require approximately ${fixedInputTokens} tokens, exceeding the ${outerInputBudget}-token budget.`
          )
        }

        console.warn(
          `[SummarizationMiddleware] Whole-conversation summary remains above the outer model input budget (${retryEstimatedTokens} estimated tokens > ${outerInputBudget}); requesting one bounded shorter handoff (target ${targetSummaryTokens} tokens).`
        )
        const shortenedSummary = await createSummary(
          [finalSummaryMessage],
          resolvedModel,
          fallbackModel,
          summaryAttemptBudget,
          null,
          null,
          request.runtime?.signal,
          targetSummaryTokens,
          1
        )
        const shortenedSummaryMessage = buildSummaryMessage(
          shortenedSummary,
          finalFilePath,
          initialUserRequest
        )
        const shortenedEstimatedTokens = estimateOuterInputTokens([shortenedSummaryMessage])
        if (shortenedEstimatedTokens > outerInputBudget) {
          throw new Error(
            `Shortened whole-conversation summary still exceeds the outer model input budget (${shortenedEstimatedTokens} estimated tokens > ${outerInputBudget}).`
          )
        }
        finalSummaryMessage = shortenedSummaryMessage
        modifiedMessages = [shortenedSummaryMessage]
      }
      await handler({ ...request, messages: modifiedMessages })
    }

    return new Command({
      update: {
        _summarizationEvent: {
          cutoffIndex: finalStateCutoffIndex,
          summaryMessage: finalSummaryMessage,
          filePath: finalFilePath
        } satisfies SummarizationEvent,
        _summarizationSessionId: getSessionId(request.state, owner, initialOwnerSessionId),
        ...(owner ? { [SUMMARIZATION_STATE_OWNER_KEY]: owner } : {})
      }
    })
  }

  return createMiddleware({
    name: "SummarizationMiddleware",
    stateSchema: SummarizationStateSchema,
    async wrapModelCall(request, handler) {
      const owner = getStateOwner(request)
      const effectiveMessages = getEffectiveMessages(request.messages ?? [], request.state, owner)
      if (effectiveMessages.length === 0) return handler(request)

      const resolvedModel = await getChatModel()
      const resolvedFallbackModel = await getFallbackChatModel()
      const maxInputTokens = getMaxInputTokens(resolvedModel)
      applyModelDefaults(resolvedModel)
      const initialTokens = countTotalTokens(
        effectiveMessages,
        request.systemMessage,
        request.tools
      )
      const { messages: truncatedMessages, modified: truncateModified } = truncateArgs(
        effectiveMessages,
        initialTokens,
        maxInputTokens
      )
      // Match DeepAgents Python's count-once behavior: tool schema conversion
      // is comparatively expensive, so share the initial count across argument
      // truncation and trigger checks. Recount only when truncation changed the
      // actual outbound messages.
      const totalTokens = truncateModified
        ? countTotalTokens(truncatedMessages, request.systemMessage, request.tools)
        : initialTokens
      const triggerTokens = countTokensForTrigger(truncatedMessages, totalTokens)
      let triggerError: unknown

      if (!shouldSummarize(truncatedMessages, triggerTokens.tokens, maxInputTokens)) {
        try {
          return await handler({ ...request, messages: truncatedMessages })
        } catch (error) {
          if (!isCmbContextOverflow(error)) throw error
          triggerError = error
          if (maxInputTokens && totalTokens > 0) {
            const observedRatio = maxInputTokens / totalTokens
            if (observedRatio > tokenEstimationMultiplier) {
              tokenEstimationMultiplier = observedRatio * 1.1
            }
          }
        }
      }

      const previousEvent = getValidSummarizationEvent(request.state, owner)
      const largestMessages = effectiveMessages
        .map((message, index) => ({
          index,
          id: message.id,
          type: message.getType(),
          contentChars:
            typeof message.content === "string"
              ? message.content.length
              : JSON.stringify(message.content).length,
          estimatedTokens: countTokensApproximately([message])
        }))
        .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
        .slice(0, 10)
      const diagnostics = new CompactionDiagnostics({
        reason: triggerError ? "provider_overflow" : "threshold",
        tokenEstimator: "characters_divided_by_4_with_provider_usage_floor",
        retryBudgetUnit: "utf8_bytes_of_serialized_summary_messages",
        owner,
        trigger,
        keep,
        contextWindowTokens: maxInputTokens,
        summaryMaxOutputTokens,
        postCompactionInputBudgetTokens,
        rawMessageCount: request.messages.length,
        effectiveMessageCount: effectiveMessages.length,
        previousCutoffIndex: previousEvent?.cutoffIndex,
        previousSummaryChars: previousEvent
          ? String(previousEvent.summaryMessage.content).length
          : 0,
        initialEstimatedTokens: initialTokens,
        systemAndToolsEstimatedTokens: countTotalTokens([], request.systemMessage, request.tools),
        estimatedTokensAfterArgumentTrimming: totalTokens,
        argumentTrimmingApplied: truncateModified,
        ...triggerTokens,
        tokenEstimationMultiplier,
        adjustedTriggerTokens: Math.ceil(triggerTokens.tokens * tokenEstimationMultiplier),
        largestMessages,
        ...(triggerError ? { error: compactionErrorDetails(triggerError) } : {})
      })
      const observedHandler = async (next: typeof request) => {
        diagnostics.record("agent_attempt", {
          messageCount: next.messages.length,
          estimatedInputTokens: countTotalTokens(next.messages, next.systemMessage, next.tools)
        })
        try {
          return await handler(next)
        } catch (error) {
          diagnostics.record("agent_error", {
            overflow: isCmbContextOverflow(error),
            error: compactionErrorDetails(error)
          })
          throw error
        }
      }
      try {
        const result = await performSummarization(
          request as any,
          observedHandler,
          truncatedMessages,
          resolvedModel,
          resolvedFallbackModel,
          maxInputTokens,
          owner,
          effectiveMessages,
          diagnostics,
          triggerError !== undefined
        )
        await diagnostics.finish("completed", options.onDiagnostic)
        return result
      } catch (error) {
        diagnostics.record("error", { error: compactionErrorDetails(error) })
        await diagnostics.finish(
          request.runtime?.signal?.aborted ? "cancelled" : "failed",
          options.onDiagnostic
        )
        throw error
      }
    }
  })
}
