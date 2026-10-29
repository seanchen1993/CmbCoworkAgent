import type {
  TabState,
  Message,
  SessionMeta,
  QuestionDef,
  DesignExecutionEvent,
  DesignApprovalDecision,
  DesignApprovalRequest,
  DesignModelRetryState,
  DesignSkillReference,
  DesignArtifactMetadata
} from "../renderer/src/components/design/types"
import type { DesignDraftPreview, DesignGenerationMetrics } from "./design-progressive"
import type { DesignTweakCommand, DesignTweaksState } from "./design-tweaks"
import type {
  DesignAppliedPatch,
  DesignPatchMetrics,
  DesignPatchRequest,
  DesignPatchStatus
} from "./design-patch"
import type { DesignTweakValue } from "./design-protocol"
import type { DesignEditCommand, DesignEditableDocument } from "./design-edit"

export type { TabState, Message, SessionMeta }
export type DesignRunKind = "questions" | "agent" | "image" | "patch"
export interface DesignRunRequest {
  requestId: string
  designSessionId: string
  kind: DesignRunKind
  prompt: string
  modelId?: string
  cleanUserMsg?: string
  isIteration?: boolean
  imageData?: string
  mimeType?: string
  skill?: DesignSkillReference | null
  sourceArtifactPath?: string | null
  freshAgentThread?: boolean
  rollback?: Partial<TabState> | null
  currentHtml?: string
  patch?: DesignPatchRequest
}
export interface DesignRunEvent {
  type: string
  preview?: DesignDraftPreview
  tweaks?: DesignTweaksState | null
  metrics?: DesignGenerationMetrics
  token?: string
  html?: string
  questions?: unknown[]
  error?: string
  event?: unknown
  attempt?: number
  maxRetries?: number
  reason?: string
  delayMs?: number
  artifactPath?: string
  metadata?: DesignArtifactMetadata
  patchStatus?: DesignPatchStatus
  patchMetrics?: DesignPatchMetrics
  patchResult?: {
    patch: DesignAppliedPatch
    baseSourceHash: string
    baseTweakRevision: number
    tweakReads: Record<string, DesignTweakValue>
    tweakUpdates: Record<string, DesignTweakValue>
    externalFiles?: Record<string, string>
  }
}
export interface DesignSessionSnapshot {
  id: string
  seq: number
  meta: SessionMeta
  state: TabState
  workspacePath: string | null
  activeRunId: string | null
  lastSeenSeq: number
}
export interface DesignSessionChange {
  id: string
  seq: number
  meta: SessionMeta
  snapshot?: DesignSessionSnapshot
  deleted?: boolean
  draftHtmlOmitted?: boolean
}
export interface DesignSessionSeed {
  id: string
  meta: SessionMeta
  state: TabState
  workspacePath: string | null
}
export interface DesignSessionApi {
  inspectEditable?: (id: string) => Promise<DesignEditableDocument>
  edit?: (id: string, command: DesignEditCommand) => Promise<DesignSessionSnapshot>
  patchHistory?: (
    id: string,
    operation: "undo" | "redo",
    revision: number
  ) => Promise<DesignSessionSnapshot>
  tweak?: (id: string, command: DesignTweakCommand) => Promise<DesignSessionSnapshot>
  previewVisible?: (id: string, runId: string, revision: number) => Promise<void>
  migrate: (seeds: DesignSessionSeed[]) => Promise<SessionMeta[]>
  list: () => Promise<SessionMeta[]>
  create: (seed: DesignSessionSeed) => Promise<DesignSessionSnapshot>
  open: (id: string) => Promise<DesignSessionSnapshot>
  close: (id: string) => Promise<void>
  patch: (
    id: string,
    patch: Partial<TabState>,
    meta?: Partial<SessionMeta>
  ) => Promise<DesignSessionSnapshot>
  start: (request: DesignRunRequest) => Promise<DesignSessionSnapshot>
  stop: (id: string) => Promise<DesignSessionSnapshot>
  retry: (id: string, requestId: string) => Promise<DesignSessionSnapshot>
  setWorkspace: (id: string, path: string) => Promise<DesignSessionSnapshot>
  delete: (id: string) => Promise<void>
  markRead: (id: string, seq: number) => Promise<void>
  onChange: (listener: (change: DesignSessionChange) => void) => () => void
}
export const DESIGN_UI_FIELDS = [
  "inputValue",
  "zoom",
  "tweaksOn",
  "activeMode",
  "rightTab",
  "activeVariationId",
  "comments",
  "draftComment",
  "activeCommentId",
  "drawStrokes",
  "drawElementHints",
  "drawNotes",
  "draftDrawNote",
  "drawToolMode",
  "iframeScrollX",
  "iframeScrollY",
  "iframeContentWidth",
  "iframeContentHeight",
  "editModeAvailable",
  "selectedElement",
  "selectedModelId",
  "selectedSkill",
  "selectedDesignSystemId",
  "attachedImage",
  "attachedFiles",
  "codeContext",
  "designLink",
  "answers",
  "variationPanelPosition"
] as const satisfies readonly (keyof TabState)[]

const DESIGN_HTML_PROGRESS_TEXT = "正在生成 HTML 设计稿..."
const DESIGN_HTML_PROGRESS_PATTERN =
  /```html|<!doctype|<html[\s>]|<head[\s>]|<body[\s>]|<style[\s>]|<script[\s>]/i
const DESIGN_TOOL_MARKUP_PROGRESS_PATTERN =
  /(?:[<＜]\s*[|｜]?DSML[|｜]?\s*[>＞]|tool Calls|invoke name=|parameter name=|<\/\s*[|｜]?DSML[|｜]?\s*>)/i
const DESIGN_TOOL_PROGRESS_LINE_PATTERN = /^\s*(?:读取文件|写入文件|修改文件|编辑文件):/i
const THINK_OPEN_PATTERN = /<think\b[^>]*>?/i
const THINK_CLOSE_PATTERN = /<\/think>/i
const THINK_PARTIAL_OPEN_PATTERN = /<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i
const THINK_PARTIAL_CLOSE_PATTERN = /<\/t(?:h(?:i(?:n(?:k)?)?)?)?$/i
const DIRECT_DESIGN_REQUEST_PATTERN =
  /\b(skip questions|no questions|just build|build directly|directly generate)\b|(?:直接|马上|立刻)(?:生成|开始|做|出图|出页面)|(?:不要|不用|无需|别)(?:问|提问|问题|澄清|确认)|跳过(?:问题|问答|提问|澄清)/i

export function shouldSkipDesignQuestions(prompt: string): boolean {
  return DIRECT_DESIGN_REQUEST_PATTERN.test(prompt)
}

const MULTI_VARIATION_INSTRUCTION =
  "Generate 2 distinct variations (A / B) within one HTML file for exploration. " +
  "Variation A should be conventional and safe; Variation B should be more distinctive. " +
  'Use direct body children with id="variation-a" and id="variation-b" plus concise Chinese data-label values.'

const CANONICAL_ARTIFACT_INSTRUCTION =
  'Generate exactly ONE canonical design artifact. Do NOT generate A/B variations, do NOT create elements with id="variation-a" or id="variation-b", and do NOT present alternative versions.'

export function buildNewDesignPrompt(
  basePrompt: string,
  options: { designSystemId?: string | null; forceVariations?: boolean } = {}
): string {
  const instruction = options.designSystemId
    ? CANONICAL_ARTIFACT_INSTRUCTION
    : MULTI_VARIATION_INSTRUCTION
  return `${basePrompt}\n\n---\n${instruction}\n\n始终使用中文回答。`
}

export function clampDesignProgressText(content: string): string {
  return content
}

export function createDesignProgressNormalizer(): (token: string) => string {
  let insideThinkBlock = false
  let insideHtmlArtifact = false
  let htmlProgressEmitted = false
  let pendingThinkTagFragment = ""

  return (token: string): string => {
    if (!token || insideHtmlArtifact) return ""

    let visible = ""
    let remaining = `${pendingThinkTagFragment}${token}`
    pendingThinkTagFragment = ""

    while (remaining) {
      if (insideThinkBlock) {
        const close = remaining.match(THINK_CLOSE_PATTERN)
        if (!close || close.index === undefined) {
          const partialClose = remaining.match(THINK_PARTIAL_CLOSE_PATTERN)
          if (partialClose?.index !== undefined) {
            pendingThinkTagFragment = partialClose[0]
          }
          return visible
        }
        remaining = remaining.slice(close.index + close[0].length)
        insideThinkBlock = false
        continue
      }

      const open = remaining.match(THINK_OPEN_PATTERN)
      if (!open || open.index === undefined) {
        const partialOpen = remaining.match(THINK_PARTIAL_OPEN_PATTERN)
        if (partialOpen?.index !== undefined) {
          visible += remaining.slice(0, partialOpen.index)
          pendingThinkTagFragment = partialOpen[0]
          break
        }
        visible += remaining
        break
      }

      visible += remaining.slice(0, open.index)
      remaining = remaining.slice(open.index + open[0].length)

      const close = remaining.match(THINK_CLOSE_PATTERN)
      if (!close || close.index === undefined) {
        insideThinkBlock = true
        break
      }
      remaining = remaining.slice(close.index + close[0].length)
    }

    visible = visible.replace(THINK_CLOSE_PATTERN, "")
    if (!visible.trim()) return ""
    if (DESIGN_TOOL_MARKUP_PROGRESS_PATTERN.test(visible)) return ""
    if (DESIGN_TOOL_PROGRESS_LINE_PATTERN.test(visible) || /^OK$/i.test(visible.trim())) return ""

    if (DESIGN_HTML_PROGRESS_PATTERN.test(visible)) {
      insideHtmlArtifact = true
      if (htmlProgressEmitted) return ""
      htmlProgressEmitted = true
      return DESIGN_HTML_PROGRESS_TEXT
    }

    return visible
  }
}

export function normalizeQuestionDef(raw: unknown): QuestionDef | null {
  if (!raw || typeof raw !== "object") return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : ""
  if (!id) return null
  const rawType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "text"
  let type: QuestionDef["type"]
  switch (rawType) {
    case "radio":
    case "select":
    case "checkbox":
    case "chips":
      type = "chips"
      break
    case "direction-cards":
      type = "direction-cards"
      break
    case "textarea":
      type = "textarea"
      break
    default:
      type = "text"
  }
  const options = Array.isArray(item.options)
    ? item.options
        .map((option) => {
          if (typeof option === "string") return { value: option, label: option }
          if (option && typeof option === "object") {
            const obj = option as Record<string, unknown>
            const label = typeof obj.label === "string" ? obj.label : ""
            const value = typeof obj.value === "string" ? obj.value : label
            return value ? { value, label: label || value } : null
          }
          return null
        })
        .filter((option): option is { value: string; label: string } => Boolean(option))
    : []
  const optionLabels = Object.fromEntries(options.map((option) => [option.value, option.label]))
  return {
    id,
    type,
    label: typeof item.label === "string" ? item.label : id,
    hint:
      typeof item.hint === "string"
        ? item.hint
        : typeof item.help === "string"
          ? item.help
          : undefined,
    options: options.map((option) => option.value),
    optionLabels,
    cards: Array.isArray(item.cards) ? (item.cards as QuestionDef["cards"]) : undefined,
    multi: item.multi === true || rawType === "checkbox",
    required: item.required === true,
    maxSelections: typeof item.maxSelections === "number" ? item.maxSelections : undefined,
    placeholder: typeof item.placeholder === "string" ? item.placeholder : undefined
  }
}

export function asDesignApprovalRequest(request: unknown): DesignApprovalRequest {
  if (!request || typeof request !== "object") return {}
  const req = request as Record<string, unknown>
  return {
    ...req,
    _orchestratorRequestId: typeof req.id === "string" ? req.id : undefined,
    _retryReason: typeof req.retry_reason === "string" ? req.retry_reason : undefined,
    _approvalTypes: Array.isArray(req.allowed_approval_types)
      ? (req.allowed_approval_types as DesignApprovalDecision[])
      : undefined
  } as DesignApprovalRequest
}

export function asDesignExecutionEvent(event: unknown): DesignExecutionEvent | null {
  if (!event || typeof event !== "object") return null
  const raw = event as Partial<DesignExecutionEvent>
  if (
    raw.kind !== "tool_call" &&
    raw.kind !== "tool_result" &&
    raw.kind !== "used_skill" &&
    raw.kind !== "assistant_text" &&
    raw.kind !== "validation"
  )
    return null
  return {
    kind: raw.kind,
    id: typeof raw.id === "string" ? raw.id : undefined,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    args:
      raw.args && typeof raw.args === "object" && !Array.isArray(raw.args) ? raw.args : undefined,
    content: typeof raw.content === "string" ? raw.content : undefined,
    isError: raw.isError === true,
    status:
      raw.status === "success" || raw.status === "error" || raw.status === "running"
        ? raw.status
        : raw.kind === "tool_result"
          ? raw.isError
            ? "error"
            : "success"
          : "running",
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now()
  }
}

export function asDesignModelRetryState(event: unknown): DesignModelRetryState | null {
  if (!event || typeof event !== "object") return null
  const raw = event as Partial<DesignModelRetryState>
  if (typeof raw.attempt !== "number" || typeof raw.maxRetries !== "number") return null
  return {
    attempt: raw.attempt,
    maxRetries: raw.maxRetries,
    reason: typeof raw.reason === "string" ? raw.reason : "模型暂时不可用",
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0
  }
}

export function patchLastAssistantMessage(messages: Message[], patch: Partial<Message>): Message[] {
  const next = [...messages]
  const last = next.length - 1
  if (next[last]?.role !== "assistant") return messages
  next[last] = { ...next[last], ...patch }
  return next
}

export function appendDesignExecutionEvent(
  events: DesignExecutionEvent[],
  event: DesignExecutionEvent
): DesignExecutionEvent[] {
  if (event.kind === "assistant_text") {
    if (!event.content?.trim()) return events
    const content = clampDesignProgressText(event.content)
    const eventId = event.id
    if (eventId && eventId !== "assistant-progress") {
      const index = events.findIndex(
        (item) => item.kind === "assistant_text" && item.id === eventId
      )
      if (index >= 0) {
        const next = [...events]
        const current = next[index]
        next[index] = {
          ...current,
          ...event,
          content: clampDesignProgressText(
            eventId === "assistant-progress" ? `${current.content ?? ""}${content}` : content
          ),
          timestamp: current.timestamp
        }
        return next
      }
    }
    const last = events[events.length - 1]
    if (last?.kind === "assistant_text" && (!eventId || last.id === eventId)) {
      const next = [...events]
      next[next.length - 1] = {
        ...last,
        content: clampDesignProgressText(`${last.content ?? ""}${content}`),
        timestamp: event.timestamp
      }
      return next
    }
    return [...events, { ...event, content }]
  }

  if (event.kind === "used_skill") {
    if (!event.name) {
      return events
    }
    const index = events.findIndex((item) => item.kind === "used_skill" && item.name === event.name)
    if (index < 0) return [...events, event]
    const next = [...events]
    const current = next[index]
    const shouldKeepCompletedStatus =
      (current.status === "success" || current.status === "error") && event.status === "running"
    next[index] = {
      ...current,
      ...event,
      status: shouldKeepCompletedStatus ? current.status : event.status,
      isError: shouldKeepCompletedStatus ? current.isError : event.isError
    }
    return next
  }

  if (event.kind === "tool_call") {
    const toolCallId = event.toolCallId || event.id
    const index = toolCallId
      ? events.findIndex(
          (item) => item.kind === "tool_call" && (item.toolCallId || item.id) === toolCallId
        )
      : -1
    if (index >= 0) {
      const next = [...events]
      const current = next[index]
      next[index] = {
        ...current,
        ...event,
        args: event.args && Object.keys(event.args).length > 0 ? event.args : current.args,
        name: event.name || current.name,
        timestamp: current.timestamp
      }
      return next
    }
    return [...events, event]
  }

  if (event.kind === "validation") {
    const index = events.findLastIndex((item) => item.kind === "validation")
    if (index >= 0) {
      const next = [...events]
      next[index] = { ...next[index], ...event }
      return next
    }
    return [...events, event]
  }

  const resultKey = event.id || event.toolCallId
  if (
    resultKey &&
    events.some((item) => item.kind === "tool_result" && (item.id || item.toolCallId) === resultKey)
  ) {
    return events
  }
  const next = events.map((item) => {
    if (item.kind !== "tool_call") return item
    if (!event.toolCallId || (item.toolCallId || item.id) !== event.toolCallId) return item
    return { ...item, status: event.status, isError: event.isError }
  })
  return [...next, event]
}

export function makeDesignAgentThreadId(designSessionId: string | null, tabId: string): string {
  const safeSessionId =
    String(designSessionId || "session")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "") || "session"
  const safeTabId =
    String(tabId || "tab")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "") || "tab"
  return `design_${safeSessionId}_${safeTabId}`.slice(0, 120)
}

export function createDesignState(): TabState {
  return {
    messages: [],
    html: "",
    draftPreview: null,
    tweaks: null,
    generationMetrics: {},
    sourceInfo: null,
    generationState: "idle",
    questions: [],
    answers: {},
    originalPrompt: "",
    rightTab: "design",
    variations: [],
    activeVariationId: null,
    tweaksOn: false,
    activeMode: null,
    zoom: 100,
    inputValue: "",
    comments: [],
    draftComment: null,
    activeCommentId: null,
    drawStrokes: [],
    drawElementHints: [],
    drawNotes: [],
    draftDrawNote: null,
    drawToolMode: "draw",
    iframeScrollX: 0,
    iframeScrollY: 0,
    iframeContentWidth: 0,
    iframeContentHeight: 0,
    editModeAvailable: false,
    selectedElement: null,
    attachedImage: null,
    selectedModelId: null,
    reloadKey: 0,
    selectedSkill: null,
    selectedDesignSystemId: null,
    codeContext: null,
    designLink: null,
    attachedFiles: null,
    retryPrompt: null,
    retryIsIteration: false,
    retryCleanMsg: null,
    retrySkill: null,
    artifactPath: null,
    artifactMetadata: null,
    variationPanelPosition: null,
    apiHistory: [],
    pendingApproval: null
  }
}
