import React, { useState, useRef, useCallback, useEffect } from "react"
import { v4 as uuid } from "uuid"
import { inlineHtmlSiblingAssets } from "@/lib/html-srcdoc"
import { useAppStore } from "@/lib/store"
import { CodeModal } from "./CodeModal"
import { CustomModelDialog } from "../chat/CustomModelDialog"
import {
  CommentIcon,
  ContextPill,
  DesignApprovalBar,
  DrawIcon,
  EditIcon,
  EmptyState,
  ModelSelector,
  RightTabBtn,
  ToolbarIcon,
  TweaksBtn
} from "./DesignControls"
import { CommentDraftInput, CommentPin } from "./DesignComments"
import {
  DrawActionBar,
  DrawLayer,
  type ResolvedDraftDrawNote,
  type ResolvedDrawNote,
  type ResolvedDrawStroke
} from "./DesignDraw"
import { DesignGallery } from "./DesignGallery"
import { CreateDesignModal, ExportDesignModal, LinkModal } from "./DesignModals"
import { ElementPropsPanel } from "./ElementPropsPanel"
import { getDrawElementLabel } from "./drawUtils"
import { PulsingDot } from "./common"
import { MessageBubble } from "./MessageBubble"
import { QuestionsPanel } from "./QuestionsPanel"
import { S } from "./styles"
import { TweaksFloatingPanel } from "./TweaksFloatingPanel"
import type {
  AnswerValue,
  ChatTab,
  CommentItem,
  DesignApprovalDecision,
  DesignApprovalRequest,
  DesignContextSyncResult,
  DesignElementAnchor,
  DesignExecutionEvent,
  DesignArtifactMetadata,
  DesignModelRetryState,
  DesignSessionKind,
  DesignSkillReference,
  DesignSystemInfo,
  DesignSourceInfo,
  DrawElementHint,
  DrawNote,
  DrawPoint,
  DrawStroke,
  DrawToolMode,
  AnchoredDrawPoint,
  ElementStyles,
  FileAttachment,
  FloatingPanelPosition,
  Message,
  MessageAttachment,
  ModelOption,
  QuestionDef,
  RightPanelTab,
  SessionMeta,
  SkillInfo,
  TabState,
  VariationItem
} from "./types"
import { SINGLE_DESIGN_TAB_ID, SINGLE_DESIGN_TAB_LABEL } from "./types"

function getPathName(filePath: string | null): string {
  if (!filePath) return ""
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

function groupByLabel<T>(
  items: T[],
  getLabel: (item: T) => string | null | undefined
): Array<{ label: string; items: T[] }> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const label = getLabel(item)?.trim() || "其他"
    const next = groups.get(label) ?? []
    next.push(item)
    groups.set(label, next)
  }
  return Array.from(groups.entries())
    .map(([label, groupItems]) => ({ label, items: groupItems }))
    .sort((a, b) => {
      const order = [
        "核心",
        "原型",
        "演示稿",
        "模板",
        "设计系统",
        "技能",
        "AI 与大模型平台",
        "效率工具与 SaaS",
        "设计与创作工具",
        "开发工具与 IDE",
        "后端、数据库与 DevOps",
        "金融科技与加密",
        "电商与零售",
        "媒体与消费科技",
        "汽车",
        "其他",
        "Core",
        "prototype",
        "deck",
        "template",
        "design-system",
        "skills",
        "Other"
      ]
      const aIndex = order.indexOf(a.label)
      const bIndex = order.indexOf(b.label)
      if (aIndex >= 0 || bIndex >= 0) {
        return (aIndex >= 0 ? aIndex : order.length) - (bIndex >= 0 ? bIndex : order.length)
      }
      return a.label.localeCompare(b.label, "zh-CN")
    })
}

function getTemplateModeLabel(mode: string | undefined): string {
  if (mode === "prototype") return "原型"
  if (mode === "deck") return "演示稿"
  if (mode === "template") return "模板"
  if (mode === "design-system") return "设计系统"
  return mode || "技能"
}

function getDesignSystemGroupLabel(label: string | null | undefined): string {
  switch (label) {
    case "Core":
      return "核心"
    case "AI & LLM Platforms":
      return "AI 与大模型平台"
    case "Backend, Database & DevOps":
      return "后端、数据库与 DevOps"
    case "Design & Creative Tools":
      return "设计与创作工具"
    case "Developer Tools & IDEs":
      return "开发工具与 IDE"
    case "E-commerce & Retail":
      return "电商与零售"
    case "Fintech & Crypto":
      return "金融科技与加密"
    case "Media & Consumer Tech":
      return "媒体与消费科技"
    case "Productivity & SaaS":
      return "效率工具与 SaaS"
    case "Automotive":
      return "汽车"
    default:
      return label?.trim() || "其他"
  }
}

const DESIGN_SYSTEM_DISPLAY_ORDER = new Map<string, number>([
  ["wplus", 0],
  ["wealth", 1]
])

function compareDesignSystemsForDisplay(a: DesignSystemInfo, b: DesignSystemInfo): number {
  const aPinned = DESIGN_SYSTEM_DISPLAY_ORDER.get(a.id)
  const bPinned = DESIGN_SYSTEM_DISPLAY_ORDER.get(b.id)
  if (aPinned !== undefined || bPinned !== undefined) {
    return (aPinned ?? Number.MAX_SAFE_INTEGER) - (bPinned ?? Number.MAX_SAFE_INTEGER)
  }
  return a.name.localeCompare(b.name, "zh-CN")
}

function getDefaultDesignSystemId(systems: DesignSystemInfo[]): string | null {
  return systems.find((system) => system.id === "neutral-modern")?.id ?? systems[0]?.id ?? null
}

function getSessionKindLabel(
  kind: DesignSessionKind | DesignSourceInfo["kind"] | undefined
): string {
  switch (kind) {
    case "import_url":
      return "链接还原"
    case "import_html":
      return "HTML 导入"
    case "prototype_zip":
      return "原型导入"
    default:
      return "新设计"
  }
}

function makeFileHref(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`
  }
  if (normalized.startsWith("//")) {
    return `file:${encodeURI(normalized)}`
  }
  return `file://${encodeURI(normalized)}`
}

const MAX_DESIGN_PROGRESS_TEXT_CHARS = 1200
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

function shouldSkipDesignQuestions(prompt: string): boolean {
  return DIRECT_DESIGN_REQUEST_PATTERN.test(prompt)
}

const MULTI_VARIATION_INSTRUCTION =
  "Generate 2 distinct variations (A / B) within one HTML file for exploration. " +
  "Variation A should be conventional and safe; Variation B should be more distinctive. " +
  "Use direct body children with id=\"variation-a\" and id=\"variation-b\" plus concise Chinese data-label values."

const CANONICAL_ARTIFACT_INSTRUCTION =
  "Generate exactly ONE canonical design artifact. Do NOT generate A/B variations, do NOT create elements with id=\"variation-a\" or id=\"variation-b\", and do NOT present alternative versions."

function buildNewDesignPrompt(
  basePrompt: string,
  options: { designSystemId?: string | null; forceVariations?: boolean } = {}
): string {
  const instruction = options.designSystemId
    ? CANONICAL_ARTIFACT_INSTRUCTION
    : MULTI_VARIATION_INSTRUCTION
  return `${basePrompt}\n\n---\n${instruction}\n\n始终使用中文回答。`
}

function clampDesignProgressText(content: string): string {
  if (content.length <= MAX_DESIGN_PROGRESS_TEXT_CHARS) return content
  return `...${content.slice(-MAX_DESIGN_PROGRESS_TEXT_CHARS)}`
}

function createDesignProgressNormalizer(): (token: string) => string {
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

function makeTabState(): TabState {
  return {
    messages: [],
    html: "",
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
    selectedModelId: getLastModelId(), // default to last-used model
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

function makeDesignAgentThreadId(designSessionId: string | null, tabId: string): string {
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

function getCurrentDesignHtml(state: TabState | undefined): string {
  if (!state) return ""
  if (state.activeVariationId) {
    const variationHtml = state.variations.find((v) => v.id === state.activeVariationId)?.html
    if (variationHtml?.trim()) return variationHtml
  }
  return state.html?.trim() ?? ""
}

function hasExistingDesignArtifact(state: TabState | undefined): boolean {
  return getCurrentDesignHtml(state).length > 0
}

type DesignIterationRollbackSnapshot = {
  html: string
  variations: VariationItem[]
  activeVariationId: string | null
  comments: CommentItem[]
  draftComment: TabState["draftComment"]
  activeCommentId: string | null
  drawStrokes: DrawStroke[]
  drawElementHints: DrawElementHint[]
  drawNotes: DrawNote[]
  draftDrawNote: TabState["draftDrawNote"]
  inputValue: string
  artifactMetadata: DesignArtifactMetadata | null
  apiHistory: Array<{ role: "user" | "assistant"; content: string }>
}

function makeIterationRollbackSnapshot(
  state: TabState | undefined
): DesignIterationRollbackSnapshot | null {
  if (!state) return null
  // Keep this in sync when adding user-editable TabState fields that must survive failed iterations.
  return {
    html: state.html,
    variations: state.variations,
    activeVariationId: state.activeVariationId,
    comments: state.comments,
    draftComment: state.draftComment,
    activeCommentId: state.activeCommentId,
    drawStrokes: state.drawStrokes,
    drawElementHints: state.drawElementHints,
    drawNotes: state.drawNotes,
    draftDrawNote: state.draftDrawNote,
    inputValue: state.inputValue,
    artifactMetadata: state.artifactMetadata,
    apiHistory: state.apiHistory ?? []
  }
}

function restoreIterationRollbackSnapshot(
  snapshot: DesignIterationRollbackSnapshot,
  prev: TabState
): Partial<TabState> {
  return {
    html: snapshot.html,
    variations: snapshot.variations,
    activeVariationId: snapshot.activeVariationId,
    comments: snapshot.comments,
    draftComment: snapshot.draftComment,
    activeCommentId: snapshot.activeCommentId,
    drawStrokes: snapshot.drawStrokes,
    drawElementHints: snapshot.drawElementHints,
    drawNotes: snapshot.drawNotes,
    draftDrawNote: snapshot.draftDrawNote,
    inputValue: snapshot.inputValue,
    artifactMetadata: snapshot.artifactMetadata,
    apiHistory: snapshot.apiHistory,
    reloadKey: prev.reloadKey + 1
  }
}

function hydrateTabStateHtml(state: TabState, html: string): TabState {
  const baseHtml = ensureEditMode(html)
  const hasDesignSystem = Boolean(state.selectedDesignSystemId)
  const patchedHtml = hasDesignSystem ? collapseVariationsToSingleArtifact(baseHtml) : baseHtml
  const variations = hasDesignSystem ? [] : parseVariations(patchedHtml)
  return {
    ...state,
    html: patchedHtml,
    variations,
    activeVariationId:
      state.activeVariationId && variations.some((v) => v.id === state.activeVariationId)
        ? state.activeVariationId
        : (variations[0]?.id ?? null),
    reloadKey: state.reloadKey + 1
  }
}

function makeHydrationGuardFingerprint(state: TabState | undefined): string {
  if (!state) return ""
  return JSON.stringify({
    html: state.html,
    messages: state.messages.map((msg) => [msg.role, msg.content, msg.isStreaming ?? false]),
    variations: state.variations.map((variation) => [
      variation.id,
      variation.label,
      variation.html
    ]),
    activeVariationId: state.activeVariationId,
    artifactPath: state.artifactPath ?? null,
    artifactMetadata: state.artifactMetadata ?? null,
    generationState: state.generationState
  })
}

function promptLooksLikeFileOperation(prompt: string): boolean {
  const text = prompt.trim().toLowerCase()
  if (!text) return false
  const patterns = [
    "write_file",
    "edit_file",
    "read_file",
    "apply_patch",
    "保存到文件",
    "写入文件",
    "修改文件",
    "编辑文件",
    "更新文件",
    "读取文件",
    "生成代码文件",
    "写到项目里",
    "落到代码里",
    "save to file",
    "write to file",
    "edit file",
    "modify file",
    "update file",
    "read file",
    "apply patch"
  ]
  return patterns.some((pattern) => text.includes(pattern))
}

function getWorkspaceRequirementReason(options: {
  selectedSkill: SkillInfo | null
  codeContext: Array<{ filename: string; content: string }> | null
  prompt: string
}): string | null {
  if (options.selectedSkill) return "当前请求使用了 skill"
  if (options.codeContext && options.codeContext.length > 0) return "当前请求附带了代码上下文"
  if (promptLooksLikeFileOperation(options.prompt)) return "当前请求涉及文件操作"
  return null
}

function normalizeQuestionDef(raw: unknown): QuestionDef | null {
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

function saveDesignArtifactForTab(
  artifactId: string,
  html: string,
  workspacePath: string | null,
  tabId: string,
  updateTs: (
    tabId: string,
    patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)
  ) => void,
  existingArtifactPath?: string | null,
  metadata?: Partial<DesignArtifactMetadata>
): void {
  if (!html.trim()) return
  if (!workspacePath) return
  const savePromise = existingArtifactPath
    ? window.api.design.saveArtifactFile(
        existingArtifactPath,
        html,
        workspacePath ?? undefined,
        metadata as Record<string, unknown>
      )
    : window.api.design.saveArtifact(
        artifactId,
        html,
        workspacePath ?? undefined,
        metadata as Record<string, unknown>
      )
  savePromise
    .then(async (result) => {
      if (!result.success && existingArtifactPath) {
        result = await window.api.design.saveArtifact(
          artifactId,
          html,
          workspacePath ?? undefined,
          metadata as Record<string, unknown>
        )
      }
      if (result.success && result.filePath) {
        window.api.design.storeHtml(artifactId, html).catch((err) => {
          console.warn("[Design] storeHtml failed", err)
        })
        updateTs(tabId, { artifactPath: result.filePath })
      }
    })
    .catch((err) => {
      console.warn("[Design] saveArtifact failed", err)
      if (existingArtifactPath) {
        window.api.design
          .saveArtifact(
            artifactId,
            html,
            workspacePath ?? undefined,
            metadata as Record<string, unknown>
          )
          .then((result) => {
            if (result.success && result.filePath) {
              window.api.design.storeHtml(artifactId, html).catch((storeErr) => {
                console.warn("[Design] storeHtml failed", storeErr)
              })
              updateTs(tabId, { artifactPath: result.filePath })
            }
          })
          .catch((fallbackErr) => {
            console.warn("[Design] saveArtifact fallback failed", fallbackErr)
          })
      }
    })
}

type PendingArtifactSave = {
  artifactId: string
  html: string
  workspacePath: string | null
  tabId: string
  existingArtifactPath?: string | null
  metadata?: Partial<DesignArtifactMetadata>
}

function flushPendingArtifactSave(
  pendingSave: PendingArtifactSave | null,
  updateTs: (
    tabId: string,
    patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)
  ) => void
): void {
  if (!pendingSave) return
  saveDesignArtifactForTab(
    pendingSave.artifactId,
    pendingSave.html,
    pendingSave.workspacePath,
    pendingSave.tabId,
    updateTs,
    pendingSave.existingArtifactPath,
    pendingSave.metadata
  )
}

function buildDesignArtifactMetadata(input: {
  artifactId: string
  title?: string
  prompt?: string
  modelId?: string | null
  skill?: DesignSkillReference | null
  designSystem?: DesignSystemInfo | null
  sourceInfo?: DesignSourceInfo | null
  html: string
  variations: VariationItem[]
}): DesignArtifactMetadata {
  const now = new Date().toISOString()
  return {
    artifactId: input.artifactId,
    title: input.title,
    prompt: input.prompt,
    modelId: input.modelId ?? null,
    skillName: input.skill?.name ?? null,
    skillPath: input.skill?.path ?? null,
    designSystemId: input.designSystem?.id ?? null,
    designSystemName: input.designSystem?.name ?? null,
    designSystemCategory: input.designSystem?.category ?? null,
    sourceKind: input.sourceInfo?.kind,
    sourceLabel: input.sourceInfo?.label,
    createdAt: now,
    updatedAt: now,
    variations: input.variations.map((variation) => ({ id: variation.id, label: variation.label })),
    preview: {
      thumbnailText: input.html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120)
    }
  }
}

function asDesignArtifactMetadata(raw: unknown): DesignArtifactMetadata | null {
  if (!raw || typeof raw !== "object") return null
  const data = raw as DesignArtifactMetadata
  if (typeof data.artifactId !== "string" || typeof data.updatedAt !== "string") return null
  return data
}

function makeDesignArtifactId(sessionId: string | null, tabId: string): string {
  return `${sessionId ?? "session"}_${tabId}`
}

function asDesignApprovalRequest(request: unknown): DesignApprovalRequest {
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

function asDesignExecutionEvent(event: unknown): DesignExecutionEvent | null {
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

function asDesignModelRetryState(event: unknown): DesignModelRetryState | null {
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

function patchLastAssistantMessage(messages: Message[], patch: Partial<Message>): Message[] {
  const next = [...messages]
  const last = next.length - 1
  if (next[last]?.role !== "assistant") return messages
  next[last] = { ...next[last], ...patch }
  return next
}

function appendDesignExecutionEvent(
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

// ─────────────────────────────────────────────────────────
// Parse A/B/C variations from a full HTML string
// Looks for elements with id="variation-a/b/c"
// ─────────────────────────────────────────────────────────
function parseVariations(fullHtml: string): VariationItem[] {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(fullHtml, "text/html")
    const headHtml = doc.head.innerHTML

    return (["a", "b"] as const).reduce<VariationItem[]>((acc, id) => {
      const el = doc.getElementById(`variation-${id}`)
      if (!el) return acc

      // Read descriptive label from data-label attribute; fall back to generic
      const dataLabel = el.getAttribute("data-label")?.trim()
      const label = dataLabel || `方案 ${id.toUpperCase()}`

      // Wrap variation in a self-contained HTML doc, inherit shared head (fonts, styles).
      // The model's shared JS often references ALL variation elements (e.g. to hide variation-b/c).
      // In a standalone file only variation-A is in the body, so those getElementById calls return
      // null → TypeError → the entire JS init crashes → blank page.
      // Fix: include hidden stub divs for the OTHER variations so JS references don't throw.
      const otherIds = (["a", "b"] as const).filter((v) => v !== id)
      const stubs = otherIds
        .map(
          (v) =>
            `<div id="variation-${v}" style="display:none!important;visibility:hidden!important;position:absolute!important;pointer-events:none!important"></div>`
        )
        .join("\n")

      const rawHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${headHtml}
<style>html,body{margin:0;padding:0;min-height:100vh;}</style>
</head>
<body>
${el.outerHTML}
${stubs}
</body>
</html>`
      const html = ensureEditMode(rawHtml)

      acc.push({ id, label, html })
      return acc
    }, [])
  } catch {
    return []
  }
}

function collapseVariationsToSingleArtifact(fullHtml: string): string {
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(fullHtml, "text/html")
    const primary = doc.getElementById("variation-a") ?? doc.getElementById("variation-b")
    if (!primary) return fullHtml

    const headHtml = doc.head.innerHTML
    const primaryId = primary.id === "variation-b" ? "b" : "a"
    const stubs = (["a", "b"] as const)
      .filter((id) => id !== primaryId)
      .map(
        (id) =>
          `<div id="variation-${id}" style="display:none!important;visibility:hidden!important;position:absolute!important;pointer-events:none!important"></div>`
      )
      .join("\n")

    return ensureEditMode(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${headHtml}
<style>html,body{margin:0;padding:0;min-height:100vh;}</style>
</head>
<body>
${primary.outerHTML}
${stubs}
</body>
</html>`)
  } catch {
    return fullHtml
  }
}

function escapeCssIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value)
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&")
}

function getElementTextSignature(element: Element): string {
  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("alt") ||
    element.textContent ||
    ""
  )
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 48)
}

function getScreenLabelForElement(element: Element): string | undefined {
  const screen = element.closest("[data-screen-label],[data-design-anchor],[data-dm-screen]")
  return (
    screen?.getAttribute("data-screen-label") ||
    screen?.getAttribute("data-design-anchor") ||
    screen?.getAttribute("data-dm-screen") ||
    undefined
  )
}

function attrSelector(element: Element, attr: string, value: string): string {
  return `${element.tagName.toLowerCase()}[${attr}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`
}

function buildElementSelector(element: Element): string {
  const preferredAttrs = [
    "data-design-anchor",
    "data-screen-label",
    "data-dm-ref",
    "data-cc-id",
    "aria-label",
    "role"
  ]
  for (const attr of preferredAttrs) {
    const value = element.getAttribute(attr)
    if (value) {
      const selector = attrSelector(element, attr, value)
      if (element.ownerDocument.querySelectorAll(selector).length === 1) return selector
    }
  }

  if (element.id) {
    const selector = `#${escapeCssIdent(element.id)}`
    if (element.ownerDocument.querySelectorAll(selector).length === 1) return selector
  }

  const parts: string[] = []
  let current: Element | null = element
  while (
    current &&
    current !== current.ownerDocument.documentElement &&
    current !== current.ownerDocument.body
  ) {
    let part = current.tagName.toLowerCase()
    const anchorAttr = ["data-design-anchor", "data-screen-label", "data-dm-ref", "data-cc-id"]
      .map((attr) => ({ attr, value: current?.getAttribute(attr) || "" }))
      .find((item) => item.value)
    if (anchorAttr && current) {
      parts.unshift(attrSelector(current, anchorAttr.attr, anchorAttr.value))
      break
    }
    if (current.id) {
      part += `#${escapeCssIdent(current.id)}`
      parts.unshift(part)
      break
    }
    const className = Array.from(current.classList)
      .filter((value) => value && !value.startsWith("__"))
      .slice(0, 2)
      .map((value) => `.${escapeCssIdent(value)}`)
      .join("")
    part += className
    const parent = current.parentElement
    if (parent) {
      const siblings = Array.from(parent.children).filter((child): child is Element => {
        return child instanceof Element && child.tagName === current?.tagName
      })
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    parts.unshift(part)
    current = parent
    if (parts.length >= 5) break
  }
  return parts.join(" > ")
}

function getPointAnchor(doc: Document | null, point: DrawPoint): DesignElementAnchor | undefined {
  if (!doc) return undefined
  const win = doc.defaultView
  if (!win) return undefined
  const element = doc.elementFromPoint(
    Math.round(point.x - win.scrollX),
    Math.round(point.y - win.scrollY)
  )
  if (!element || element === doc.documentElement || element === doc.body) return undefined
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return {
    selector: buildElementSelector(element),
    tagName: element.tagName.toLowerCase(),
    label: getDrawElementLabel(element),
    role: element.getAttribute("role") || undefined,
    text: getElementTextSignature(element) || undefined,
    screenLabel: getScreenLabelForElement(element),
    offsetXRatio: Math.min(1, Math.max(0, (point.x - win.scrollX - rect.left) / rect.width)),
    offsetYRatio: Math.min(1, Math.max(0, (point.y - win.scrollY - rect.top) / rect.height))
  }
}

function getDominantPointAnchor(
  doc: Document | null,
  points: DrawPoint[]
): DesignElementAnchor | undefined {
  if (!doc || points.length === 0) return undefined
  const sampleCount = Math.min(8, points.length)
  const step = Math.max(1, Math.floor(points.length / sampleCount))
  const anchors = points
    .filter((_, index) => index % step === 0)
    .slice(0, sampleCount)
    .map((point) => getPointAnchor(doc, point))
    .filter((anchor): anchor is DesignElementAnchor => Boolean(anchor))
  if (anchors.length === 0) return undefined

  const counts = new Map<string, { anchor: DesignElementAnchor; count: number }>()
  for (const anchor of anchors) {
    const key = anchor.selector || anchor.label || `${anchor.tagName}:${anchor.text ?? ""}`
    const current = counts.get(key)
    counts.set(key, { anchor, count: (current?.count ?? 0) + 1 })
  }

  return Array.from(counts.values()).sort((left, right) => right.count - left.count)[0]?.anchor
}

function resolveAnchorElement(
  doc: Document | null,
  anchor: DesignElementAnchor | undefined
): Element | null {
  if (!doc || !anchor?.selector) return null
  try {
    const direct = doc.querySelector(anchor.selector)
    if (direct) return direct
  } catch {
    // Fall through to softer matching below.
  }
  const candidates = Array.from(doc.querySelectorAll(anchor.tagName || "*"))
  const byLabel = anchor.label
    ? candidates.find((element) => getDrawElementLabel(element) === anchor.label)
    : null
  if (byLabel) return byLabel
  const byText = anchor.text
    ? candidates.find((element) => getElementTextSignature(element) === anchor.text)
    : null
  return byText ?? null
}

function resolveAnchorPagePoint(
  doc: Document | null,
  anchor: DesignElementAnchor | undefined
): DrawPoint | null {
  const element = resolveAnchorElement(doc, anchor)
  const win = doc?.defaultView
  if (!element || !win || !anchor) return null
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: win.scrollX + rect.left + rect.width * anchor.offsetXRatio,
    y: win.scrollY + rect.top + rect.height * anchor.offsetYRatio
  }
}

function anchorPointsForStroke(
  doc: Document | null,
  stroke: DrawStroke
): AnchoredDrawPoint[] | undefined {
  const element = resolveAnchorElement(doc, stroke.anchor)
  const win = doc?.defaultView
  if (!element || !win) return undefined
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return undefined
  return stroke.points.map((point) => ({
    xRatio: (point.x - win.scrollX - rect.left) / rect.width,
    yRatio: (point.y - win.scrollY - rect.top) / rect.height
  }))
}

function resolveAnchoredStrokePoints(doc: Document | null, stroke: DrawStroke): DrawPoint[] {
  const element = resolveAnchorElement(doc, stroke.anchor)
  const win = doc?.defaultView
  if (!element || !win || !stroke.anchoredPoints?.length) return stroke.points
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return stroke.points
  return stroke.anchoredPoints.map((point) => ({
    x: win.scrollX + rect.left + rect.width * point.xRatio,
    y: win.scrollY + rect.top + rect.height * point.yRatio
  }))
}

function getAnchoredElementSummary(anchor: DesignElementAnchor | undefined): string {
  if (!anchor) return ""
  return [
    anchor.label,
    anchor.screenLabel ? `screen:${anchor.screenLabel}` : "",
    anchor.selector ? `selector:${anchor.selector}` : ""
  ]
    .filter(Boolean)
    .join("；")
}

// File attachment limits — mirrors ChatContainer
const DESIGN_MAX_ATTACHMENTS_DISPLAY = 3

// Last-used model persistence
const DESIGN_LAST_MODEL_KEY = "design_last_model_id"
function normalizeDesignModelId(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim()
  if (!trimmed) return null
  return trimmed.startsWith("custom:") ? trimmed : `custom:${trimmed}`
}
function getLastModelId(): string | null {
  try {
    return normalizeDesignModelId(localStorage.getItem(DESIGN_LAST_MODEL_KEY))
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────
// Session persistence — localStorage
// ─────────────────────────────────────────────────────────
const DESIGN_STORAGE_KEY = "design_session_v2"
const MAX_HTML_BYTES = 200_000 // 200 KB cap per HTML blob to keep storage reasonable

type PersistedTabState = {
  messages: Message[]
  html: string
  sourceInfo?: DesignSourceInfo | null
  variations: Array<{ id: string; label: string; html: string }>
  activeVariationId: string | null
  selectedModelId: string | null
  tweaksOn: boolean
  zoom: number
  comments: CommentItem[]
  drawStrokes?: DrawStroke[]
  drawElementHints?: DrawElementHint[]
  drawNotes?: DrawNote[]
  drawToolMode?: DrawToolMode
  codeContext: Array<{ filename: string; content: string }> | null
  designLink: string | null
  selectedDesignSystemId?: string | null
  rightTab: RightPanelTab
  apiHistory?: Array<{ role: "user" | "assistant"; content: string }>
  artifactPath?: string | null
  artifactMetadata?: DesignArtifactMetadata | null
  variationPanelPosition?: FloatingPanelPosition | null
}

interface PersistedSession {
  chatTabs: ChatTab[]
  activeTabId: string
  tabStates: Record<string, PersistedTabState>
}

function sanitizePersistedMessages(messages: Message[]): Message[] {
  return messages
    .filter((message) => {
      return !(message.role === "assistant" && message.isStreaming && !message.content.trim())
    })
    .map((message) => {
      if (message.role !== "assistant") return message
      return {
        ...message,
        isStreaming: false,
        modelRetry: null
      }
    })
}

function serializeTs(ts: TabState): PersistedTabState {
  return {
    messages: sanitizePersistedMessages(ts.messages),
    html: ts.html.slice(0, MAX_HTML_BYTES),
    sourceInfo: ts.sourceInfo,
    variations: ts.variations.map((v) => ({
      id: v.id,
      label: v.label,
      html: v.html.slice(0, MAX_HTML_BYTES)
    })),
    activeVariationId: ts.activeVariationId,
    selectedModelId: ts.selectedModelId,
    tweaksOn: ts.tweaksOn,
    zoom: ts.zoom,
    comments: ts.comments,
    drawStrokes: ts.drawStrokes,
    drawElementHints: ts.drawElementHints,
    drawNotes: ts.drawNotes,
    drawToolMode: ts.drawToolMode,
    codeContext: ts.codeContext,
    designLink: ts.designLink,
    selectedDesignSystemId: ts.selectedDesignSystemId,
    rightTab: ts.rightTab,
    apiHistory: ts.apiHistory,
    artifactPath: ts.artifactPath,
    artifactMetadata: ts.artifactMetadata,
    variationPanelPosition: ts.variationPanelPosition
  }
}

function deserializeTs(p: PersistedTabState): TabState {
  return {
    ...makeTabState(),
    ...p,
    selectedModelId: normalizeDesignModelId(p.selectedModelId),
    messages: sanitizePersistedMessages(p.messages ?? []),
    sourceInfo: p.sourceInfo ?? null,
    drawStrokes: p.drawStrokes ?? [],
    drawElementHints: p.drawElementHints ?? [],
    drawNotes: p.drawNotes ?? [],
    drawToolMode: p.drawToolMode ?? "draw",
    selectedDesignSystemId: p.selectedDesignSystemId ?? null,
    apiHistory: p.apiHistory ?? [],
    artifactPath: p.artifactPath ?? null,
    artifactMetadata: p.artifactMetadata ?? null,
    variationPanelPosition: p.variationPanelPosition ?? null,
    generationState: "idle", // always reset — never restore mid-stream
    activeMode: null,
    inputValue: "",
    reloadKey: 1 // non-zero so iframe loads on restore
  }
}

function defaultSession() {
  return {
    chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }] as ChatTab[],
    activeTabId: SINGLE_DESIGN_TAB_ID,
    tabStates: { [SINGLE_DESIGN_TAB_ID]: makeTabState() } as Record<string, TabState>
  }
}

function normalizeSingleTabSession(
  session: ReturnType<typeof defaultSession>
): ReturnType<typeof defaultSession> {
  const preferredId =
    (session.activeTabId && session.tabStates[session.activeTabId] && session.activeTabId) ||
    session.chatTabs[0]?.id ||
    Object.keys(session.tabStates)[0] ||
    SINGLE_DESIGN_TAB_ID
  const preferredState = session.tabStates[preferredId] ?? makeTabState()
  return {
    chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }],
    activeTabId: SINGLE_DESIGN_TAB_ID,
    tabStates: { [SINGLE_DESIGN_TAB_ID]: preferredState }
  }
}

async function readPreviewDependencyTextFile(resolvedPath: string): Promise<string | null> {
  const result = await window.api.file.readText(resolvedPath)
  return result.success ? (result.content ?? null) : null
}

async function readPreviewDependencyDataUrlFile(resolvedPath: string): Promise<string | null> {
  const result = await window.api.file.readDataUrl(resolvedPath)
  return result.success ? (result.dataUrl ?? null) : null
}

async function prepareHtmlForSrcDoc(html: string, htmlPath?: string | null): Promise<string> {
  const inlinedHtml = htmlPath
    ? await inlineHtmlSiblingAssets({
        html,
        htmlPath,
        readTextFile: readPreviewDependencyTextFile,
        readDataUrlFile: readPreviewDependencyDataUrlFile
      })
    : html
  const htmlWithBase = htmlPath ? injectBaseHref(inlinedHtml, makeFileHref(htmlPath)) : inlinedHtml
  return ensureEditMode(htmlWithBase)
}

// ── Per-session storage ───────────────────────────────────
const SESSION_INDEX_KEY = "design_index_v1"
const SESSION_LAST_KEY = "design_last_session"
const sessionDataKey = (id: string) => `design_session_v2_${id}`

function parsePersistedSession(raw: string): ReturnType<typeof defaultSession> {
  const data: PersistedSession = JSON.parse(raw)
  if (!Array.isArray(data.chatTabs) || !data.chatTabs.length || !data.activeTabId)
    return defaultSession()
  const restoredStates: Record<string, TabState> = {}
  for (const [id, st] of Object.entries(data.tabStates ?? {})) {
    restoredStates[id] = deserializeTs(st)
  }
  data.chatTabs.forEach((t) => {
    if (!restoredStates[t.id]) restoredStates[t.id] = makeTabState()
  })
  return normalizeSingleTabSession({
    chatTabs: data.chatTabs,
    activeTabId: data.activeTabId,
    tabStates: restoredStates
  })
}

async function hydrateSessionArtifacts(
  sessionId: string,
  session: ReturnType<typeof defaultSession>,
  workspacePath: string | null
): Promise<ReturnType<typeof defaultSession>> {
  const entries = await Promise.all(
    Object.entries(session.tabStates).map(async ([tabId, state]) => {
      const artifactId = makeDesignArtifactId(sessionId, tabId)
      let result: {
        success: boolean
        filePath?: string
        html?: string
        metadata?: unknown
        error?: string
      }
      if (state.artifactPath) {
        result = await window.api.design.readArtifactFile(
          state.artifactPath,
          workspacePath ?? undefined
        )
      } else {
        result = await window.api.design.readArtifact(artifactId, workspacePath ?? undefined)
      }
      if (!result.success || !result.html?.trim()) return [tabId, state] as const

      const previewHtml = await prepareHtmlForSrcDoc(
        result.html,
        result.filePath ?? state.artifactPath
      )
      window.api.design.storeHtml(artifactId, previewHtml).catch((err) => {
        console.warn("[Design] storeHtml failed", err)
      })
      return [
        tabId,
        {
          ...hydrateTabStateHtml(state, previewHtml),
          artifactPath: result.filePath ?? state.artifactPath,
          artifactMetadata: asDesignArtifactMetadata(result.metadata) ?? state.artifactMetadata
        }
      ] as const
    })
  )

  return {
    ...session,
    tabStates: Object.fromEntries(entries)
  }
}

function loadSessionById(id: string): ReturnType<typeof defaultSession> {
  try {
    const raw = localStorage.getItem(sessionDataKey(id))
    if (!raw) return defaultSession()
    return parsePersistedSession(raw)
  } catch {
    return defaultSession()
  }
}

function loadIndex(): SessionMeta[] {
  try {
    const raw = localStorage.getItem(SESSION_INDEX_KEY)
    if (raw) return JSON.parse(raw) as SessionMeta[]

    // ── One-time migration from old single-session format ──
    const oldRaw = localStorage.getItem(DESIGN_STORAGE_KEY)
    if (!oldRaw) return []
    const data: PersistedSession = JSON.parse(oldRaw)
    if (!data.chatTabs?.length) return []
    const firstTabId = data.chatTabs[0]?.id ?? ""
    const firstState = (data.tabStates ?? {})[firstTabId] as PersistedTabState | undefined
    const firstMsg = firstState?.messages?.find((m) => m.role === "user")
    const title = ((firstMsg?.content as string) ?? "").slice(0, 24) || "无标题设计"
    const id = `ds_${uuid().slice(0, 8)}`
    localStorage.setItem(sessionDataKey(id), oldRaw)
    localStorage.setItem(SESSION_LAST_KEY, id)
    const meta: SessionMeta = { id, title, createdAt: Date.now(), updatedAt: Date.now() }
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify([meta]))
    return [meta]
  } catch {
    return []
  }
}

function saveIndex(index: SessionMeta[]) {
  try {
    localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index))
  } catch {
    // Ignore storage write failures for the gallery index.
  }
}

function updateIndexMeta(id: string, patch: Partial<SessionMeta>) {
  try {
    const index = loadIndex()
    const i = index.findIndex((m) => m.id === id)
    if (i >= 0) {
      index[i] = { ...index[i], ...patch }
      saveIndex(index)
    }
  } catch {
    // Ignore metadata update failures and keep the current index.
  }
}

// ─────────────────────────────────────────────────────────
// Scroll tracker — always injected on iframe load.
// Sends the iframe's scroll position to the parent whenever it changes.
// This is separate from comment mode so pins stay aligned even if
// the user scrolls before/after entering comment mode.
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Navigation blocker — always injected on iframe load.
// Prevents any link click or form submission from navigating
// the iframe away from the design preview.
// ─────────────────────────────────────────────────────────

const NAV_BLOCK_INJECT = `(function(){
  if(window.__nb_active)return;
  window.__nb_active=true;
  // Block <a href> navigation
  document.addEventListener('click',function(e){
    var el=e.target;
    while(el&&el!==document){
      if(el.tagName==='A'&&el.getAttribute('href')&&el.getAttribute('href')!=='#'){
        e.preventDefault();e.stopPropagation();return;
      }
      el=el.parentElement;
    }
  },true);
  // Block form submissions
  document.addEventListener('submit',function(e){
    e.preventDefault();e.stopPropagation();
  },true);
})();`

const SCROLL_INJECT = `(function(){
  if(window.__st_active)return;
  window.__st_active=true;
  function report(){
    var de=document.documentElement,body=document.body;
    var w=Math.max(de?de.scrollWidth:0,body?body.scrollWidth:0,de?de.offsetWidth:0,body?body.offsetWidth:0,window.innerWidth||0);
    var h=Math.max(de?de.scrollHeight:0,body?body.scrollHeight:0,de?de.offsetHeight:0,body?body.offsetHeight:0,window.innerHeight||0);
    window.parent.postMessage({type:'__iframe_scroll',x:window.scrollX,y:window.scrollY,width:w,height:h},'*');
  }
  window.addEventListener('scroll',report,{passive:true});
  window.addEventListener('resize',report);
  if(typeof ResizeObserver!=='undefined'){
    window.__st_ro=new ResizeObserver(report);
    window.__st_ro.observe(document.documentElement);
    if(document.body)window.__st_ro.observe(document.body);
  }
  report();
  window.__st_cleanup=function(){
    window.removeEventListener('scroll',report);
    window.removeEventListener('resize',report);
    if(window.__st_ro){window.__st_ro.disconnect();delete window.__st_ro;}
    window.__st_active=false;delete window.__st_cleanup;
  };
})();`

// ─────────────────────────────────────────────────────────
// Comment mode injection script (runs inside the iframe)
// ─────────────────────────────────────────────────────────

const COMMENT_INJECT = `(function(){
  if(window.__cm_active)return;
  window.__cm_active=true;
  var sty=document.createElement('style');
  sty.id='__cm_sty';
  sty.textContent='.__cm_h{outline:2px solid rgba(245,158,11,0.7)!important;outline-offset:1px!important;cursor:crosshair!important;transition:outline 0.08s;}';
  document.head.appendChild(sty);
  var hov=null;
  function over(e){
    if(hov)hov.classList.remove('__cm_h');
    var t=e.target;
    if(t&&t!==document.body&&t!==document.documentElement){hov=t;t.classList.add('__cm_h');}
  }
  function out(){if(hov){hov.classList.remove('__cm_h');hov=null;}}
  function label(t){
    if(t.id)return'#'+t.id;
    var tag=t.tagName.toLowerCase();
    var cls=Array.from(t.classList).filter(function(c){return!c.startsWith('__cm')}).slice(0,2).join('.');
    var txt=(t.textContent||'').trim().replace(/\\s+/g,' ').slice(0,28);
    return tag+(cls?'.'+cls:'')+(txt?' \\''+txt+'\\'':'');
  }
  function click(e){
    e.preventDefault();e.stopPropagation();
    // Use pageX/pageY (= clientX + scrollX) so coordinates are document-absolute,
    // not viewport-relative. This lets pins stay anchored to the content regardless
    // of the current scroll position.
    window.parent.postMessage({
      type:'__comment_click',
      pageX:e.pageX,pageY:e.pageY,
      winW:window.innerWidth,winH:window.innerHeight,
      elementDesc:label(e.target)
    },'*');
  }
  document.addEventListener('mouseover',over,true);
  document.addEventListener('mouseout',out,true);
  document.addEventListener('click',click,true);
  window.__cm_cleanup=function(){
    document.removeEventListener('mouseover',over,true);
    document.removeEventListener('mouseout',out,true);
    document.removeEventListener('click',click,true);
    var s=document.getElementById('__cm_sty');if(s)s.remove();
    if(hov)hov.classList.remove('__cm_h');
    window.__cm_active=false;delete window.__cm_cleanup;
  };
})();`

const COMMENT_CLEANUP = `(function(){if(window.__cm_cleanup)window.__cm_cleanup();})();`

// ─────────────────────────────────────────────────────────
// Edit select mode — injected into the iframe when Edit mode is active.
// Enables click-to-select with hover highlighting, sends computed styles
// of selected elements to the parent, and listens for live style change messages.
// ─────────────────────────────────────────────────────────

const EDIT_SELECT_INJECT = `(function(){
  if(window.__ed_active)return;window.__ed_active=true;
  var _ec=0,_sel=null,_hov=null;
  var _sty=document.createElement('style');_sty.id='__ed_sty';
  _sty.textContent='.__ed_s{outline:2px solid #3b82f6!important;outline-offset:-1px!important;}'+'.__ed_h{outline:1px dashed rgba(59,130,246,.55)!important;outline-offset:-1px!important;}';
  document.head.appendChild(_sty);
  function r2h(c){var m=c.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);if(!m)return c;return'#'+[m[1],m[2],m[3]].map(function(n){return parseInt(n).toString(16).padStart(2,'0')}).join('');}
  function gs(el){
    var cs=window.getComputedStyle(el),r=el.getBoundingClientRect();
    var lh=cs.lineHeight==='normal'?1.2:parseFloat(cs.lineHeight)/parseFloat(cs.fontSize);
    return{fontFamily:cs.fontFamily.replace(/['"]/g,'').split(',')[0].trim(),fontSize:Math.round(parseFloat(cs.fontSize)*10)/10,fontWeight:cs.fontWeight,color:r2h(cs.color),textAlign:cs.textAlign,lineHeight:Math.round(lh*100)/100,letterSpacing:Math.round(parseFloat(cs.letterSpacing||'0')*10)/10,width:Math.round(r.width*10)/10,height:Math.round(r.height*10)/10,opacity:parseFloat(cs.opacity),paddingTop:Math.round(parseFloat(cs.paddingTop)),paddingRight:Math.round(parseFloat(cs.paddingRight)),paddingBottom:Math.round(parseFloat(cs.paddingBottom)),paddingLeft:Math.round(parseFloat(cs.paddingLeft)),marginTop:Math.round(parseFloat(cs.marginTop)),marginRight:Math.round(parseFloat(cs.marginRight)),marginBottom:Math.round(parseFloat(cs.marginBottom)),marginLeft:Math.round(parseFloat(cs.marginLeft)),borderWidth:Math.round(parseFloat(cs.borderWidth||'0')),borderRadius:Math.round(parseFloat(cs.borderRadius||'0'))};
  }
  function over(e){if(_hov&&_hov!==_sel)_hov.classList.remove('__ed_h');var t=e.target;if(t&&t!==document.body&&t!==document.documentElement&&t!==_sel){_hov=t;t.classList.add('__ed_h');}}
  function out(){if(_hov&&_hov!==_sel){_hov.classList.remove('__ed_h');_hov=null;}}
  function ck(e){
    e.preventDefault();e.stopPropagation();
    if(_sel)_sel.classList.remove('__ed_s');
    _sel=e.target;
    if(!_sel.getAttribute('data-ed-id'))_sel.setAttribute('data-ed-id',String(++_ec));
    _sel.classList.add('__ed_s');
    if(_hov){_hov.classList.remove('__ed_h');_hov=null;}
    window.parent.postMessage({type:'__edit_click',edId:_sel.getAttribute('data-ed-id'),tagName:_sel.tagName.toLowerCase(),styles:gs(_sel)},'*');
  }
  document.addEventListener('mouseover',over,true);document.addEventListener('mouseout',out,true);document.addEventListener('click',ck,true);
  var _PX=['fontSize','letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','borderWidth','borderRadius'];
  window.addEventListener('message',function(e){
    if(!e.data)return;
    if(e.data.type==='__edit_style'&&_sel){
      var p=e.data.property,v=e.data.value;
      _sel.style[p]=_PX.indexOf(p)>-1?v+'px':String(v);
      window.parent.postMessage({type:'__edit_click',edId:_sel.getAttribute('data-ed-id'),tagName:_sel.tagName.toLowerCase(),styles:gs(_sel)},'*');
    }
    if(e.data.type==='__edit_get_html'){
      window.parent.postMessage({type:'__edit_html',html:'<!DOCTYPE html>'+document.documentElement.outerHTML},'*');
    }
  });
  window.__ed_cleanup=function(){
    document.removeEventListener('mouseover',over,true);document.removeEventListener('mouseout',out,true);document.removeEventListener('click',ck,true);
    var s=document.getElementById('__ed_sty');if(s)s.remove();
    if(_sel){_sel.classList.remove('__ed_s');_sel=null;}if(_hov){_hov.classList.remove('__ed_h');_hov=null;}
    window.__ed_active=false;delete window.__ed_cleanup;
  };
})();`

const EDIT_SELECT_CLEANUP = `(function(){if(window.__ed_cleanup)window.__ed_cleanup();})();`

/**
 * Ensures every HTML file has a functioning EDITMODE block so Edit mode always works.
 *
 * Strategy 1 – markers already present: return as-is.
 * Strategy 2 – model wrote TWEAK_DEFAULTS without markers: inject the markers.
 * Strategy 3 – CSS custom properties in :root {}: derive EDITMODE from them.
 * Strategy 4 – hardcoded hex colors in <style>: replace them with CSS var() refs,
 *               inject a :root block, and add the EDITMODE script. Always succeeds.
 */
function ensureEditMode(html: string): string {
  // 1. Already correct
  if (/\/\*EDITMODE-BEGIN\*\//.test(html)) return html

  // 2. Model wrote `const TWEAK_DEFAULTS = {...};` but without markers
  const plainMatch = html.match(/\bconst\s+TWEAK_DEFAULTS\s*=\s*(\{[\s\S]{1,4000}?\})\s*;/)
  if (plainMatch) {
    return html.replace(plainMatch[1], `/*EDITMODE-BEGIN*/${plainMatch[1]}/*EDITMODE-END*/`)
  }

  // 3. CSS custom properties already declared in :root
  const cssVars: Record<string, unknown> = {}
  for (const rootBlock of html.matchAll(/:root\s*\{([^}]+)\}/g)) {
    for (const [, name, rawVal] of rootBlock[1].matchAll(/--([a-zA-Z][\w-]+)\s*:\s*([^;]+);/g)) {
      const v = rawVal.trim()
      const key = name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) cssVars[key] = v
      else if (/^[\d.]+$/.test(v)) cssVars[key] = parseFloat(v)
      else if (/^(true|false)$/.test(v)) cssVars[key] = v === "true"
    }
  }
  if (Object.keys(cssVars).length > 0) return appendEditScript(html, cssVars)

  // 4. No CSS variables at all — extract hardcoded hex colors from <style> blocks,
  //    replace them with CSS var() references, and inject :root + EDITMODE script.
  return injectColorVars(html)
}

/** Append an EDITMODE script to html. vars keys are camelCase → CSS --kebab-case vars. */
function appendEditScript(html: string, vars: Record<string, unknown>): string {
  const setLines = Object.keys(vars)
    .map((k) => {
      const cv = "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase()
      return `r.style.setProperty('${cv}',String(t['${k}']));`
    })
    .join("")
  const script = `\n<script>(function(){
var TWEAK_DEFAULTS=/*EDITMODE-BEGIN*/${JSON.stringify(vars)}/*EDITMODE-END*/;
function applyTweaks(edits){var t=Object.assign({},TWEAK_DEFAULTS,edits||{}),r=document.documentElement;${setLines}}
window.addEventListener('message',function(e){if(e.data&&e.data.type==='__set_tweak_keys')applyTweaks(e.data.edits);});
window.parent.postMessage({type:'__edit_mode_available'},'*');
applyTweaks({});
})()</script>`
  // Try </body>, then </html>, then just append
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + "\n</body>")
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, script + "\n</html>")
  return html + script
}

/** Strategy 4: replace hardcoded hex colors in <style> with CSS vars, then inject EDITMODE. */
function injectColorVars(html: string): string {
  // Collect 6-digit hex colors from <style> blocks AND inline style="" attributes
  const styleContent = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1])
    .join("\n")
  const inlineContent = [...html.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join("\n")
  const allCssContent = styleContent + "\n" + inlineContent

  const freq: Map<string, number> = new Map()
  for (const [, h] of allCssContent.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const c = "#" + h.toLowerCase()
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }
  // Also try 3-digit hex from inline styles
  for (const [, h] of inlineContent.matchAll(/#([0-9a-fA-F]{3})\b/g)) {
    const c = "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2] // expand to 6-digit
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }

  // Take up to 6 most-used colors (skip pure black/white as they're usually decorative)
  const palette = [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([c]) => c)
    .filter((c) => c !== "#000000" && c !== "#ffffff" && c !== "#fff" && c !== "#000")
    .slice(0, 6)

  // If there are no interesting colors, still provide generic numeric tweaks
  const vars: Record<string, unknown> = {}
  const colorNames = ["primary", "secondary", "accent", "background", "surface", "muted"]

  type Entry = { key: string; cssVar: string; hex: string }
  const entries: Entry[] = palette.map((hex, i) => {
    const key = colorNames[i] ?? `color${i + 1}`
    return { key, cssVar: `--${colorNames[i] ?? "color-" + (i + 1)}`, hex }
  })
  entries.forEach(({ key, hex }) => {
    vars[key] = hex
  })

  // Numeric tweaks extracted from CSS
  const fsMatch = styleContent.match(/\bfont-size\s*:\s*([\d.]+)px/)
  if (fsMatch) vars["fontSize"] = parseFloat(fsMatch[1])
  const rrMatch = styleContent.match(/\bborder-radius\s*:\s*([\d.]+)px/)
  if (rrMatch) vars["borderRadius"] = parseFloat(rrMatch[1])

  // Fallback: if no colors at all, use sensible generic defaults
  if (entries.length === 0) {
    vars["primaryColor"] = "#3b82f6"
    vars["fontSize"] = vars["fontSize"] ?? 16
    vars["borderRadius"] = vars["borderRadius"] ?? 8
    return appendEditScript(html, vars)
  }

  // Replace hardcoded colors in <style> blocks with var() references
  let patched = html.replace(
    /<style([^>]*)>([\s\S]*?)<\/style>/gi,
    (_: string, attrs: string, content: string) => {
      let updated = content
      for (const { hex, cssVar } of entries) {
        updated = updated.replace(
          new RegExp(hex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          `var(${cssVar})`
        )
      }
      return `<style${attrs}>${updated}</style>`
    }
  )

  // Build :root variable block
  const rootBlock = `:root{${entries.map(({ cssVar, hex }) => `${cssVar}:${hex}`).join(";")}}\n`

  // Inject :root into first <style> tag if present; otherwise inject a new <style> in <head>
  if (/<style[^>]*>/i.test(patched)) {
    patched = patched.replace(/<style([^>]*)>/, `<style$1>\n${rootBlock}`)
  } else if (/<\/head>/i.test(patched)) {
    patched = patched.replace(/<\/head>/i, `<style>\n${rootBlock}</style>\n</head>`)
  } else {
    patched = `<style>\n${rootBlock}</style>\n` + patched
  }

  // Build setProperty lines: color vars + optional numeric vars
  const colorSet = entries
    .map(({ key, cssVar }) => `r.style.setProperty('${cssVar}',String(t['${key}']));`)
    .join("")
  const numSet = [
    vars["fontSize"] ? `r.style.setProperty('--font-size',t.fontSize+'px');` : "",
    vars["borderRadius"] ? `r.style.setProperty('--border-radius',t.borderRadius+'px');` : ""
  ].join("")

  const script = `\n<script>(function(){
var TWEAK_DEFAULTS=/*EDITMODE-BEGIN*/${JSON.stringify(vars)}/*EDITMODE-END*/;
function applyTweaks(edits){var t=Object.assign({},TWEAK_DEFAULTS,edits||{}),r=document.documentElement;${colorSet}${numSet}}
window.addEventListener('message',function(e){if(e.data&&e.data.type==='__set_tweak_keys')applyTweaks(e.data.edits);});
window.parent.postMessage({type:'__edit_mode_available'},'*');
applyTweaks({});
})()</script>`

  // Try </body>, then </html>, then just append
  if (/<\/body>/i.test(patched)) return patched.replace(/<\/body>/i, script + "\n</body>")
  if (/<\/html>/i.test(patched)) return patched.replace(/<\/html>/i, script + "\n</html>")
  return patched + script
}

// Merge edits into the /*EDITMODE-BEGIN*/.../*EDITMODE-END*/ JSON block in an HTML string
function mergeEditModeKeys(html: string, edits: Record<string, unknown>): string {
  return html.replace(/\/\*EDITMODE-BEGIN\*\/([\s\S]*?)\/\*EDITMODE-END\*\//, (_, existing) => {
    try {
      const current = JSON.parse(existing.trim()) as Record<string, unknown>
      const merged = { ...current, ...edits }
      return `/*EDITMODE-BEGIN*/${JSON.stringify(merged)}/*EDITMODE-END*/`
    } catch {
      return `/*EDITMODE-BEGIN*/${existing}/*EDITMODE-END*/`
    }
  })
}

function injectBaseHref(html: string, baseHref: string): string {
  if (!baseHref.trim()) return html
  if (/<base\b/i.test(html)) return html
  const safeHref = baseHref.replace(/"/g, "&quot;")
  const baseTag = `<base href="${safeHref}">`

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${baseTag}`)
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(
      /<html([^>]*)>/i,
      `<html$1>\n<head>\n${baseTag}\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n</head>`
    )
  }
  return `<!DOCTYPE html>
<html>
<head>
${baseTag}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
${html}
</body>
</html>`
}

// Send a postMessage into the iframe
function sendToIframe(iframe: HTMLIFrameElement | null, msg: object) {
  iframe?.contentWindow?.postMessage(msg, "*")
}

function injectIntoIframe(iframe: HTMLIFrameElement | null, script: string) {
  try {
    const doc = iframe?.contentDocument
    if (!doc) return
    const s = doc.createElement("script")
    s.textContent = script
    doc.head.appendChild(s)
    s.remove() // self-remove; the code already ran
  } catch {
    /* cross-origin or not yet loaded */
  }
}

// ─────────────────────────────────────────────────────────
// Main Component
// ─────────────────────────────────────────────────────────

export function DesignView(): React.JSX.Element {
  // ── Session / gallery state ───────────────────────────────
  const [sessionIndex, setSessionIndex] = useState<SessionMeta[]>(() => loadIndex())
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    () => localStorage.getItem(SESSION_LAST_KEY) ?? null
  )

  const [_init] = useState<ReturnType<typeof loadSessionById>>(() => {
    const sid = localStorage.getItem(SESSION_LAST_KEY)
    return sid ? loadSessionById(sid) : defaultSession()
  })

  const [tabStates, setTabStates] = useState<Record<string, TabState>>(_init.tabStates)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [modelDialogOpen, setModelDialogOpen] = useState(false)
  const [modelDialogSelectedId, setModelDialogSelectedId] = useState<string | undefined>(undefined)
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [designSystems, setDesignSystems] = useState<DesignSystemInfo[]>([])
  const [createDesignSystemId, setCreateDesignSystemId] = useState<string | null>(null)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  // Code & link modal state
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [codeModalOpen, setCodeModalOpen] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkModalMode, setLinkModalMode] = useState<"reference" | "import">("reference")
  const [linkModalText, setLinkModalText] = useState("")
  const [importingSource, setImportingSource] = useState<null | "url" | "html" | "prototype_zip">(
    null
  )
  const [exportChoice, setExportChoice] = useState<{
    html: string
    artifactPath: string
    relatedFileCount: number
    includesMetadata: boolean
  } | null>(null)
  const [exportingPackage, setExportingPackage] = useState(false)
  // Toast notifications
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null)
  const toastTimeoutsRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const showToast = useCallback((msg: string) => {
    const id = Date.now()
    setToast({ msg, id })
    const timeout = setTimeout(() => {
      setToast((t) => (t?.id === id ? null : t))
      toastTimeoutsRef.current = toastTimeoutsRef.current.filter((item) => item !== timeout)
    }, 3000)
    toastTimeoutsRef.current.push(timeout)
  }, [])

  // Per-tab session tracking: tabId → { cleanup, sessionId }
  // Stored in a ref so it never triggers re-renders and isn't stale across tabs
  const tabSessionsRef = useRef<Map<string, { cleanup: () => void; sessionId: string }>>(new Map())

  const { loadModels, loadProviders } = useAppStore()

  // Canvas refs
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const activeTabId = SINGLE_DESIGN_TAB_ID
  const activeTabIdRef = useRef(activeTabId)
  const tabStatesRef = useRef(tabStates)
  const fileInputRef = useRef<HTMLInputElement>(null) // images only (screenshot / 📷)
  const messageListRef = useRef<HTMLDivElement>(null)
  const skillOptionRefs = useRef<Array<HTMLDivElement | null>>([])
  const pendingArtifactSaveRef = useRef<PendingArtifactSave | null>(null)
  const artifactSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ts = tabStates[activeTabId] ?? makeTabState()

  // ── Per-tab derived values (all read from ts) ────────────────
  const inputValue = ts.inputValue
  const tweaksOn = ts.tweaksOn
  const activeMode = ts.activeMode
  const zoom = ts.zoom
  const selectedDesignSystem =
    designSystems.find((system) => system.id === ts.selectedDesignSystemId) ?? null
  const orderedDesignSystems = [...designSystems].sort(compareDesignSystemsForDisplay)
  const designSystemGroups = groupByLabel(orderedDesignSystems, (system) =>
    getDesignSystemGroupLabel(system.category || system.source)
  )

  const setInputValue = (val: string) => updateTs(activeTabId, { inputValue: val })
  const setTweaksOn = (val: boolean | ((v: boolean) => boolean)) =>
    updateTs(activeTabId, (prev) => ({
      tweaksOn: typeof val === "function" ? val(prev.tweaksOn) : val
    }))
  const setActiveMode = (val: "comment" | "edit" | "draw" | null) =>
    updateTs(activeTabId, (prev) => ({
      activeMode: val,
      draftDrawNote: val === "draw" ? prev.draftDrawNote : null
    }))
  const setZoom = (val: number | ((v: number) => number)) =>
    updateTs(activeTabId, (prev) => ({ zoom: typeof val === "function" ? val(prev.zoom) : val }))

  // ── helpers ──────────────────────────────────────────────

  const updateTs = useCallback(
    (tabId: string, patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
      setTabStates((prev) => {
        const current = prev[tabId] ?? makeTabState()
        const updates = typeof patch === "function" ? patch(current) : patch
        return { ...prev, [tabId]: { ...current, ...updates } }
      })
    },
    []
  )

  const scheduleArtifactSave = useCallback(
    (pendingSave: PendingArtifactSave) => {
      pendingArtifactSaveRef.current = pendingSave
      if (artifactSaveTimerRef.current) clearTimeout(artifactSaveTimerRef.current)
      artifactSaveTimerRef.current = setTimeout(() => {
        const save = pendingArtifactSaveRef.current
        pendingArtifactSaveRef.current = null
        artifactSaveTimerRef.current = null
        flushPendingArtifactSave(save, updateTs)
      }, 350)
    },
    [updateTs]
  )

  useEffect(() => {
    return () => {
      for (const timeout of toastTimeoutsRef.current) clearTimeout(timeout)
      toastTimeoutsRef.current = []
      if (artifactSaveTimerRef.current) clearTimeout(artifactSaveTimerRef.current)
      artifactSaveTimerRef.current = null
      flushPendingArtifactSave(pendingArtifactSaveRef.current, () => undefined)
      pendingArtifactSaveRef.current = null
    }
  }, [])

  const updatePreviewScrollState = useCallback(
    (iframeX?: number, iframeY?: number) => {
      const state = tabStatesRef.current[activeTabIdRef.current]
      const scale = Math.max((state?.zoom ?? 100) / 100, 0.25)
      const wrapperX = (previewScrollRef.current?.scrollLeft ?? 0) / scale
      const wrapperY = (previewScrollRef.current?.scrollTop ?? 0) / scale
      const win = iframeRef.current?.contentWindow
      updateTs(activeTabIdRef.current, {
        iframeScrollX: wrapperX + (iframeX ?? win?.scrollX ?? 0),
        iframeScrollY: wrapperY + (iframeY ?? win?.scrollY ?? 0)
      })
    },
    [updateTs]
  )

  const updatePreviewContentSize = useCallback(
    (width: number, height: number) => {
      const nextWidth = Math.max(0, Math.ceil(width || 0))
      const nextHeight = Math.max(0, Math.ceil(height || 0))
      const state = tabStatesRef.current[activeTabIdRef.current]
      if (
        state &&
        Math.abs((state.iframeContentWidth || 0) - nextWidth) < 1 &&
        Math.abs((state.iframeContentHeight || 0) - nextHeight) < 1
      ) {
        return
      }
      updateTs(activeTabIdRef.current, {
        iframeContentWidth: nextWidth,
        iframeContentHeight: nextHeight
      })
    },
    [updateTs]
  )

  const loadAvailableSkills = useCallback(async (): Promise<void> => {
    try {
      const pluginSkillsPromise =
        typeof window.api.skills.listPlugins === "function"
          ? window.api.skills.listPlugins().catch(() => [])
          : Promise.resolve([])

      const templatesPromise =
        typeof window.api.design.listTemplates === "function"
          ? window.api.design.listTemplates().catch(() => [])
          : Promise.resolve([])
      const [skills, pluginSkills, disabledList, templates] = await Promise.all([
        window.api.skills.list(),
        pluginSkillsPromise,
        window.api.skills.getDisabled(),
        templatesPromise
      ])
      const disabledSet = new Set(disabledList.map((name) => name.trim().toLowerCase()))
      const enabledSkills = skills.filter(
        (skill) =>
          (skill.source === "project" || skill.source === "user") &&
          !disabledSet.has(skill.name.trim().toLowerCase())
      )
      const seen = new Set(enabledSkills.map((skill) => skill.name))
      const merged = [...enabledSkills, ...pluginSkills.filter((skill) => !seen.has(skill.name))]
      setAllSkills(
        [
          ...templates.map((template) => ({
            name: template.name,
            description: template.description,
            path: template.path,
            source: "template" as const,
            mode: template.mode,
            platform: template.platform,
            scenario: template.scenario
          })),
          ...merged
            .map((skill) => ({
              name: skill.name,
              description: skill.description,
              path: skill.path
            }))
            .map((skill) => ({ ...skill, source: "skill" as const }))
        ].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      )
    } catch {
      setAllSkills([])
    }
  }, [])

  const loadDesignSystems = useCallback(async (): Promise<void> => {
    try {
      const systems = await window.api.design.listSystems()
      setDesignSystems(systems)
      setCreateDesignSystemId((prev) => {
        if (prev && systems.some((system) => system.id === prev)) return prev
        return getDefaultDesignSystemId(systems)
      })
    } catch {
      setDesignSystems([])
      setCreateDesignSystemId(null)
    }
  }, [])

  const loadDesignModels = useCallback(async (): Promise<ModelOption[]> => {
    const models = await window.api.models.list()
    const options = models.map((model) => ({
      id: model.id,
      name: model.name,
      model: model.model,
      available: model.available
    }))
    setAvailableModels(options)
    return options
  }, [])

  // ── Fetch available model configs on mount ────────────────
  useEffect(() => {
    void loadDesignModels()
    void loadModels()
    void loadProviders()
  }, [loadDesignModels, loadModels, loadProviders])

  // ── Fetch available skills on mount ───────────────────────
  useEffect(() => {
    void loadAvailableSkills()
  }, [loadAvailableSkills])

  useEffect(() => {
    void loadDesignSystems()
  }, [loadDesignSystems])

  useEffect(() => {
    let cancelled = false
    window.api.workspace
      .get()
      .then((path) => {
        if (!cancelled) setWorkspacePath(path)
      })
      .catch(() => {
        if (!cancelled) setWorkspacePath(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSelectWorkspace = useCallback(async () => {
    setWorkspaceLoading(true)
    try {
      const selectedPath = await window.api.workspace.select()
      if (selectedPath) {
        setWorkspacePath(selectedPath)
        showToast(`工作目录已切换：${getPathName(selectedPath)}`)
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "选择工作目录失败")
    } finally {
      setWorkspaceLoading(false)
    }
  }, [showToast])

  // ── Keep refs in sync ────────────────────────────────────
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  useEffect(() => {
    tabStatesRef.current = tabStates
  }, [tabStates])
  useEffect(() => {
    const messageList = messageListRef.current
    if (!messageList) return
    const frameId = window.requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [ts.messages, ts.generationState])
  // currentSessionId ref — needed inside startGeneration (which is a stable useCallback)
  // to produce a stable artifact ID without capturing a stale closure value.
  const currentSessionIdRef = useRef<string | null>(currentSessionId)
  useEffect(() => {
    currentSessionIdRef.current = currentSessionId
  }, [currentSessionId])

  const cancelDesignRunForTab = useCallback((tabId: string) => {
    const entry = tabSessionsRef.current.get(tabId)
    if (!entry) return
    entry.cleanup()
    window.api.design.cancel(entry.sessionId).catch((err) => {
      console.warn("[Design] cancel failed", err)
    })
    tabSessionsRef.current.delete(tabId)
  }, [])

  const isCurrentDesignRun = useCallback(
    (tabId: string, runSessionId: string, designSessionId: string | null): boolean => {
      const entry = tabSessionsRef.current.get(tabId)
      return currentSessionIdRef.current === designSessionId && entry?.sessionId === runSessionId
    },
    []
  )

  useEffect(() => {
    return () => {
      cancelDesignRunForTab(SINGLE_DESIGN_TAB_ID)
    }
  }, [cancelDesignRunForTab])

  useEffect(() => {
    if (!currentSessionId) return
    const session = normalizeSingleTabSession({
      chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }],
      activeTabId,
      tabStates
    })
    hydrateSessionArtifacts(currentSessionId, session, workspacePath)
      .then((hydrated) => {
        if (currentSessionIdRef.current !== currentSessionId) return
        const hydratedState = hydrated.tabStates[SINGLE_DESIGN_TAB_ID]
        const currentState = tabStatesRef.current[SINGLE_DESIGN_TAB_ID]
        const snapshotState = session.tabStates[SINGLE_DESIGN_TAB_ID]
        if (!hydratedState || !currentState) return
        const snapshotFingerprint = makeHydrationGuardFingerprint(snapshotState)
        const currentFingerprint = makeHydrationGuardFingerprint(currentState)
        if (snapshotFingerprint && currentFingerprint !== snapshotFingerprint) return
        if (makeHydrationGuardFingerprint(hydratedState) === currentFingerprint) return
        setTabStates(hydrated.tabStates)
      })
      .catch((err) => {
        console.warn("[Design] hydrateSessionArtifacts failed", err)
      })
    // Hydrate once per session/workspace; tabStates is only the initial snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, workspacePath])

  const createSession = useCallback(
    (
      metaPatch?: Partial<SessionMeta>,
      options?: {
        designSystemId?: string | null
      }
    ): string => {
      cancelDesignRunForTab(SINGLE_DESIGN_TAB_ID)
      const id = `ds_${uuid().slice(0, 8)}`
      const session = defaultSession()
      const designSystemId = options?.designSystemId ?? null
      const selectedForSession = designSystemId
        ? (designSystems.find((system) => system.id === designSystemId) ?? null)
        : null
      session.tabStates[SINGLE_DESIGN_TAB_ID] = {
        ...session.tabStates[SINGLE_DESIGN_TAB_ID],
        selectedDesignSystemId: selectedForSession?.id ?? null
      }
      setTabStates(session.tabStates)
      setCurrentSessionId(id)
      currentSessionIdRef.current = id
      localStorage.setItem(SESSION_LAST_KEY, id)
      const meta: SessionMeta = {
        id,
        title: metaPatch?.title ?? "新设计",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        kind: metaPatch?.kind ?? "prompt",
        sourceLabel: metaPatch?.sourceLabel,
        designSystemId: selectedForSession?.id ?? null,
        designSystemName: selectedForSession?.name ?? null,
        designSystemCategory: selectedForSession?.category ?? null
      }
      setSessionIndex((prev) => {
        const next = [meta, ...prev]
        saveIndex(next)
        return next
      })
      return id
    },
    [cancelDesignRunForTab, designSystems]
  )

  const newSession = useCallback(
    (designSystemId?: string | null) => {
      createSession(undefined, { designSystemId: designSystemId ?? null })
    },
    [createSession]
  )

  const ensureWorkspaceSelected = useCallback(
    async (reason: string): Promise<boolean> => {
      if (workspacePath) return true
      setWorkspaceLoading(true)
      try {
        const selectedPath = await window.api.workspace.select()
        if (!selectedPath) {
          showToast(`${reason}前请先选择工作目录。`)
          return false
        }
        setWorkspacePath(selectedPath)
        showToast(`工作目录已切换：${getPathName(selectedPath)}`)
        return true
      } catch (err) {
        showToast(err instanceof Error ? err.message : "选择工作目录失败")
        return false
      } finally {
        setWorkspaceLoading(false)
      }
    },
    [workspacePath, showToast]
  )

  const readDependencyTextFile = useCallback(
    async (resolvedPath: string): Promise<string | null> => {
      const result = await window.api.file.readText(resolvedPath)
      return result.success ? (result.content ?? null) : null
    },
    []
  )

  const syncContextFilesToWorkspace = useCallback(
    async (options: {
      codeContext: Array<{ filename: string; content: string }> | null
      attachedFiles: FileAttachment[] | null
    }): Promise<DesignContextSyncResult> => {
      if (!workspacePath || !currentSessionIdRef.current) return {}

      const result: DesignContextSyncResult = {}

      if (options.attachedFiles && options.attachedFiles.length > 0) {
        const synced = await window.api.design.syncContextFiles({
          workspacePath,
          designSessionId: currentSessionIdRef.current,
          kind: "attachments",
          files: options.attachedFiles.map((file) => ({
            filename: file.filename,
            sourcePath: file.filePath
          }))
        })
        if (!synced.success) {
          throw new Error(synced.error || "同步附件到工作目录失败")
        }
        result.attachmentsDir = synced.dirPath
        result.attachmentFiles = synced.files
      }

      if (options.codeContext && options.codeContext.length > 0) {
        const synced = await window.api.design.syncContextFiles({
          workspacePath,
          designSessionId: currentSessionIdRef.current,
          kind: "code",
          files: options.codeContext.map((file) => ({
            filename: getPathName(file.filename) || file.filename,
            sourcePath: /[\\/]/.test(file.filename) ? file.filename : undefined,
            content: file.content
          }))
        })
        if (!synced.success) {
          throw new Error(synced.error || "同步代码上下文到工作目录失败")
        }
        result.codeDir = synced.dirPath
        result.codeFiles = synced.files
      }

      return result
    },
    [workspacePath]
  )

  const applyImportedDesign = useCallback(
    (options: {
      sessionId: string
      html: string
      sourceInfo: DesignSourceInfo
      userMessage: string
      designSystemId?: string | null
    }) => {
      const tabId = SINGLE_DESIGN_TAB_ID
      const storeKey = makeDesignArtifactId(options.sessionId, tabId)
      const baseImportedHtml = ensureEditMode(options.html)
      const importedHtml = options.designSystemId
        ? collapseVariationsToSingleArtifact(baseImportedHtml)
        : baseImportedHtml
      const variations = options.designSystemId ? [] : parseVariations(importedHtml)
      const importedDesignSystem = options.designSystemId
        ? (designSystems.find((system) => system.id === options.designSystemId) ?? null)
        : null
      const artifactMetadata = buildDesignArtifactMetadata({
        artifactId: storeKey,
        title: options.sourceInfo.label,
        prompt: options.userMessage,
        modelId: null,
        skill: null,
        designSystem: importedDesignSystem,
        sourceInfo: options.sourceInfo,
        html: importedHtml,
        variations
      })

      window.api.design.storeHtml(storeKey, importedHtml).catch((err) => {
        console.warn("[Design] storeHtml failed", err)
      })
      saveDesignArtifactForTab(
        storeKey,
        importedHtml,
        workspacePath,
        tabId,
        updateTs,
        undefined,
        artifactMetadata
      )

      updateTs(tabId, (prev) => ({
        messages: [
          { role: "user" as const, content: options.userMessage },
          {
            role: "assistant" as const,
            content: "✓ 页面已还原，可直接用 Tweaks 编辑，后续追问会基于当前 HTML 继续迭代。"
          }
        ],
        html: importedHtml,
        sourceInfo: options.sourceInfo,
        generationState: "done",
        questions: [],
        answers: {},
        originalPrompt: options.userMessage,
        rightTab: "design",
        variations,
        activeVariationId: variations[0]?.id ?? null,
        tweaksOn: true,
        activeMode: "edit",
        zoom: prev.zoom,
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
        editModeAvailable: false,
        selectedElement: null,
        attachedImage: null,
        reloadKey: prev.reloadKey + 1,
        selectedSkill: null,
        selectedDesignSystemId: importedDesignSystem?.id ?? null,
        codeContext: null,
        designLink: null,
        attachedFiles: null,
        retryPrompt: null,
        retryIsIteration: false,
        retryCleanMsg: null,
        retrySkill: null,
        artifactPath: null,
        artifactMetadata,
        apiHistory: [
          { role: "user" as const, content: options.userMessage },
          { role: "assistant" as const, content: "页面已还原，可继续编辑" }
        ],
        pendingApproval: null
      }))

      updateIndexMeta(options.sessionId, {
        title: options.sourceInfo.label,
        kind: options.sourceInfo.kind,
        sourceLabel: options.sourceInfo.label,
        updatedAt: Date.now(),
        designSystemId: importedDesignSystem?.id ?? null,
        designSystemName: importedDesignSystem?.name ?? null,
        designSystemCategory: importedDesignSystem?.category ?? null
      })
      setSessionIndex(loadIndex())
    },
    [designSystems, workspacePath, updateTs]
  )

  const loadImportedHtmlFromFile = useCallback(
    async (
      filePath: string
    ): Promise<{
      html: string
      label: string
      detail: string
    }> => {
      const readResult = await window.api.file.readText(filePath)
      if (!readResult.success || !readResult.content) {
        throw new Error(readResult.error || "读取 HTML 文件失败")
      }

      const inlinedHtml = await inlineHtmlSiblingAssets({
        html: readResult.content,
        htmlPath: filePath,
        readTextFile: readDependencyTextFile,
        readDataUrlFile: readPreviewDependencyDataUrlFile
      })
      const htmlWithBase = injectBaseHref(inlinedHtml, makeFileHref(filePath))

      return {
        html: htmlWithBase,
        label: readResult.filename || getPathName(filePath) || "HTML 页面",
        detail: filePath
      }
    },
    [readDependencyTextFile]
  )

  const loadImportedHtmlFromUrl = useCallback(
    async (
      url: string
    ): Promise<{
      html: string
      label: string
      detail: string
    }> => {
      const result = await window.api.design.importFromUrl(url)
      if (!result.success || !result.html) {
        throw new Error(result.error || "抓取页面失败")
      }

      const displayUrl = result.finalUrl || url
      let label = result.title?.trim() || ""
      if (!label) {
        try {
          label = new URL(displayUrl).hostname
        } catch {
          label = displayUrl
        }
      }

      return {
        html: result.html,
        label,
        detail: displayUrl
      }
    },
    []
  )

  const openReferenceLinkModal = useCallback(() => {
    setLinkModalMode("reference")
    setLinkModalText(ts.designLink ?? "")
    setLinkModalOpen(true)
  }, [ts.designLink])

  const openImportUrlModal = useCallback(async () => {
    const ready = await ensureWorkspaceSelected("导入链接页面")
    if (!ready) return
    setCreateModalOpen(false)
    setLinkModalMode("import")
    setLinkModalText("")
    setLinkModalOpen(true)
  }, [ensureWorkspaceSelected])

  const handleImportHtmlFile = useCallback(
    async (source: "gallery" | "session") => {
      const ready = await ensureWorkspaceSelected("导入 HTML 页面")
      if (!ready) return

      setImportingSource("html")
      try {
        const picked = await window.api.file.selectCode()
        if (picked.canceled || picked.filePaths.length === 0) return

        const htmlPath = picked.filePaths.find((filePath) => /\.html?$/i.test(filePath))
        if (!htmlPath) {
          showToast("请选择 .html 或 .htm 文件")
          return
        }

        const imported = await loadImportedHtmlFromFile(htmlPath)
        const sessionId =
          source === "gallery"
            ? createSession(
                {
                  title: imported.label,
                  kind: "import_html",
                  sourceLabel: imported.label
                },
                { designSystemId: createDesignSystemId }
              )
            : (currentSessionId ??
              createSession(
                {
                  title: imported.label,
                  kind: "import_html",
                  sourceLabel: imported.label
                },
                { designSystemId: createDesignSystemId }
              ))

        applyImportedDesign({
          sessionId,
          html: imported.html,
          sourceInfo: { kind: "import_html", label: imported.label, detail: imported.detail },
          userMessage: `导入 HTML 文件：${imported.label}`,
          designSystemId:
            source === "gallery"
              ? createDesignSystemId
              : tabStatesRef.current[SINGLE_DESIGN_TAB_ID]?.selectedDesignSystemId
        })
        setCreateModalOpen(false)
      } catch (err) {
        showToast(err instanceof Error ? err.message : "导入 HTML 页面失败")
      } finally {
        setImportingSource(null)
      }
    },
    [
      ensureWorkspaceSelected,
      showToast,
      loadImportedHtmlFromFile,
      createSession,
      createDesignSystemId,
      currentSessionId,
      applyImportedDesign
    ]
  )

  const handleImportPrototypeZip = useCallback(
    async (source: "gallery" | "session") => {
      const ready = await ensureWorkspaceSelected("导入原型图压缩包")
      if (!ready) return

      setImportingSource("prototype_zip")
      try {
        const picked = await window.api.file.selectPrototypeZip()
        if (picked.canceled || picked.filePaths.length === 0) return

        const zipPath = picked.filePaths.find((filePath) => /\.zip$/i.test(filePath))
        if (!zipPath) {
          showToast("请选择 .zip 压缩包")
          return
        }

        const imported = await window.api.design.importPrototypeZip(zipPath)
        if (!imported.success || !imported.html) {
          throw new Error(imported.error || "解析原型图压缩包失败")
        }

        const label = imported.title || getPathName(zipPath) || "Pixso 原型"
        const sessionId =
          source === "gallery"
            ? createSession(
                {
                  title: label,
                  kind: "prototype_zip",
                  sourceLabel: label
                },
                { designSystemId: createDesignSystemId }
              )
            : (currentSessionId ??
              createSession(
                {
                  title: label,
                  kind: "prototype_zip",
                  sourceLabel: label
                },
                { designSystemId: createDesignSystemId }
              ))

        applyImportedDesign({
          sessionId,
          html: imported.html,
          sourceInfo: {
            kind: "prototype_zip",
            label,
            detail: `${zipPath}${imported.imageCount ? ` · ${imported.imageCount} 张图片` : ""}`
          },
          userMessage: `导入 Pixso 原型图压缩包：${label}`,
          designSystemId:
            source === "gallery"
              ? createDesignSystemId
              : tabStatesRef.current[SINGLE_DESIGN_TAB_ID]?.selectedDesignSystemId
        })
        setCreateModalOpen(false)
        showToast(`已生成原型 HTML：${imported.imageCount ?? 0} 张图片`)
      } catch (err) {
        showToast(err instanceof Error ? err.message : "导入原型图压缩包失败")
      } finally {
        setImportingSource(null)
      }
    },
    [
      ensureWorkspaceSelected,
      showToast,
      createSession,
      createDesignSystemId,
      currentSessionId,
      applyImportedDesign
    ]
  )

  const handleImportUrl = useCallback(
    async (rawUrl: string, source: "gallery" | "session") => {
      const ready = await ensureWorkspaceSelected("导入链接页面")
      if (!ready) return false

      const url = rawUrl.trim()
      if (!url) {
        showToast("请输入有效的页面链接")
        return false
      }

      setImportingSource("url")
      try {
        const imported = await loadImportedHtmlFromUrl(url)
        const sessionId =
          source === "gallery"
            ? createSession(
                {
                  title: imported.label,
                  kind: "import_url",
                  sourceLabel: imported.label
                },
                { designSystemId: createDesignSystemId }
              )
            : (currentSessionId ??
              createSession(
                {
                  title: imported.label,
                  kind: "import_url",
                  sourceLabel: imported.label
                },
                { designSystemId: createDesignSystemId }
              ))

        applyImportedDesign({
          sessionId,
          html: imported.html,
          sourceInfo: { kind: "import_url", label: imported.label, detail: imported.detail },
          userMessage: `通过链接还原页面：${imported.detail}`,
          designSystemId:
            source === "gallery"
              ? createDesignSystemId
              : tabStatesRef.current[SINGLE_DESIGN_TAB_ID]?.selectedDesignSystemId
        })
        setCreateModalOpen(false)
        return true
      } catch (err) {
        showToast(err instanceof Error ? err.message : "导入链接页面失败")
        return false
      } finally {
        setImportingSource(null)
      }
    },
    [
      ensureWorkspaceSelected,
      showToast,
      loadImportedHtmlFromUrl,
      createSession,
      createDesignSystemId,
      currentSessionId,
      applyImportedDesign
    ]
  )

  // ── Persist session to localStorage (debounced 1.5s, skip during streaming) ──
  const _persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!currentSessionId) return // don't save while in gallery
    if (_persistTimerRef.current) clearTimeout(_persistTimerRef.current)
    _persistTimerRef.current = setTimeout(() => {
      const isStreaming = Object.values(tabStates).some(
        (s) => s.generationState === "generating" || s.generationState === "asking"
      )
      if (isStreaming) return
      try {
        const payload: PersistedSession = {
          chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }],
          activeTabId,
          tabStates: Object.fromEntries(
            Object.entries(tabStates).map(([id, s]) => [id, serializeTs(s)])
          )
        }
        localStorage.setItem(sessionDataKey(currentSessionId), JSON.stringify(payload))
        // Update index metadata (title from first message, updatedAt)
        const firstState = tabStates[SINGLE_DESIGN_TAB_ID]
        const firstUserMsg = firstState?.messages?.find((m) => m.role === "user")
        const autoTitle =
          firstState?.sourceInfo?.label ||
          (firstUserMsg ? (firstUserMsg.content as string).slice(0, 24) : "新设计")
        const selectedMetaDesignSystem = firstState?.selectedDesignSystemId
          ? designSystems.find((system) => system.id === firstState.selectedDesignSystemId)
          : null
        updateIndexMeta(currentSessionId, {
          updatedAt: Date.now(),
          title: autoTitle,
          kind: firstState?.sourceInfo?.kind ?? "prompt",
          sourceLabel: firstState?.sourceInfo?.label,
          thumbnailText: firstState?.artifactMetadata?.preview?.thumbnailText,
          designSystemId:
            firstState?.selectedDesignSystemId ??
            firstState?.artifactMetadata?.designSystemId ??
            null,
          designSystemName:
            selectedMetaDesignSystem?.name ??
            firstState?.artifactMetadata?.designSystemName ??
            undefined,
          designSystemCategory:
            selectedMetaDesignSystem?.category ??
            firstState?.artifactMetadata?.designSystemCategory ??
            undefined,
          artifactPath: firstState?.artifactPath ?? undefined
        })
        setSessionIndex(loadIndex())
      } catch {
        // Ignore persistence errors and keep the current in-memory session.
      }
    }, 1500)
    return () => {
      if (_persistTimerRef.current) clearTimeout(_persistTimerRef.current)
    }
  }, [activeTabId, tabStates, currentSessionId, designSystems])

  // ── Session navigation ─────────────────────────────────────
  const openSession = useCallback(
    (id: string) => {
      cancelDesignRunForTab(SINGLE_DESIGN_TAB_ID)
      const session = normalizeSingleTabSession(loadSessionById(id))
      setTabStates(session.tabStates)
      tabStatesRef.current = session.tabStates
      setCurrentSessionId(id)
      currentSessionIdRef.current = id
      localStorage.setItem(SESSION_LAST_KEY, id)
      hydrateSessionArtifacts(id, session, workspacePath)
        .then((hydrated) => {
          if (currentSessionIdRef.current !== id) return
          const currentState = tabStatesRef.current[SINGLE_DESIGN_TAB_ID]
          const snapshotState = session.tabStates[SINGLE_DESIGN_TAB_ID]
          const snapshotFingerprint = makeHydrationGuardFingerprint(snapshotState)
          const currentFingerprint = makeHydrationGuardFingerprint(currentState)
          if (snapshotFingerprint && currentFingerprint !== snapshotFingerprint) return
          if (
            makeHydrationGuardFingerprint(hydrated.tabStates[SINGLE_DESIGN_TAB_ID]) ===
            currentFingerprint
          )
            return
          setTabStates(hydrated.tabStates)
        })
        .catch((err) => {
          console.warn("[Design] hydrateSessionArtifacts failed", err)
        })
    },
    [cancelDesignRunForTab, workspacePath]
  )

  const backToGallery = useCallback(() => {
    cancelDesignRunForTab(SINGLE_DESIGN_TAB_ID)
    setCurrentSessionId(null)
    currentSessionIdRef.current = null
    localStorage.removeItem(SESSION_LAST_KEY)
    setSessionIndex(loadIndex())
  }, [cancelDesignRunForTab])

  const deleteSession = useCallback(
    (id: string) => {
      if (currentSessionIdRef.current === id) {
        cancelDesignRunForTab(SINGLE_DESIGN_TAB_ID)
      }
      localStorage.removeItem(sessionDataKey(id))
      setSessionIndex((prev) => {
        const next = prev.filter((m) => m.id !== id)
        saveIndex(next)
        return next
      })
    },
    [cancelDesignRunForTab]
  )

  // ── Inject / remove mode scripts when activeMode changes ─
  useEffect(() => {
    if (activeMode === "comment") {
      injectIntoIframe(iframeRef.current, COMMENT_INJECT)
      injectIntoIframe(iframeRef.current, EDIT_SELECT_CLEANUP)
    } else if (activeMode === "edit") {
      injectIntoIframe(iframeRef.current, COMMENT_CLEANUP)
      injectIntoIframe(iframeRef.current, EDIT_SELECT_INJECT)
    } else if (activeMode === "draw") {
      injectIntoIframe(iframeRef.current, COMMENT_CLEANUP)
      injectIntoIframe(iframeRef.current, EDIT_SELECT_CLEANUP)
    } else {
      injectIntoIframe(iframeRef.current, COMMENT_CLEANUP)
      injectIntoIframe(iframeRef.current, EDIT_SELECT_CLEANUP)
      sendToIframe(iframeRef.current, { type: "__deactivate_edit_mode" })
    }
    if (activeMode !== "edit") {
      updateTs(activeTabId, { selectedElement: null })
    }
    return () => {
      injectIntoIframe(iframeRef.current, COMMENT_CLEANUP)
      injectIntoIframe(iframeRef.current, EDIT_SELECT_CLEANUP)
      sendToIframe(iframeRef.current, { type: "__deactivate_edit_mode" })
    }
  }, [activeMode, activeTabId, updateTs])

  // ── Listen for all postMessages from iframe ───────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data
      if (!msg?.type) return

      // ── Iframe scroll position update ─────────────────────
      if (msg.type === "__iframe_scroll") {
        const { x, y, width, height } = msg as {
          x: number
          y: number
          width?: number
          height?: number
        }
        if (typeof width === "number" || typeof height === "number") {
          updatePreviewContentSize(width ?? 0, height ?? 0)
        }
        updatePreviewScrollState(x, y)
        return
      }

      // ── Comment click ──────────────────────────────────────
      if (msg.type === "__comment_click") {
        const { pageX, pageY, elementDesc } = msg as {
          pageX: number
          pageY: number
          elementDesc: string
        }
        const anchor = getPointAnchor(iframeRef.current?.contentDocument ?? null, {
          x: pageX,
          y: pageY
        })
        updateTs(activeTabIdRef.current, {
          draftComment: {
            pageX,
            pageY,
            elementDesc: anchor?.label || elementDesc || "元素",
            anchor
          },
          activeCommentId: null
        })
        return
      }

      // ── Edit mode: iframe announces it has a Tweaks panel ──
      if (msg.type === "__edit_mode_available") {
        updateTs(activeTabIdRef.current, { editModeAvailable: true })
        // If we're already in edit mode (e.g. iframe just reloaded), immediately activate
        // Read current activeMode from the tab state via the ref
        setTabStates((prev) => {
          const tabId = activeTabIdRef.current
          const state = prev[tabId]
          if (state?.activeMode === "edit") {
            // Send activation — but we can't call sendToIframe here (side-effect in setState)
            // Instead, schedule it as a microtask
            Promise.resolve().then(() =>
              sendToIframe(iframeRef.current, { type: "__activate_edit_mode" })
            )
          }
          return prev // no state change needed
        })
        return
      }

      // ── Edit select: user clicked an element in the iframe ───
      if (msg.type === "__edit_click") {
        const { edId, tagName, styles } = msg as {
          edId: string
          tagName: string
          styles: ElementStyles
        }
        updateTs(activeTabIdRef.current, { selectedElement: { edId, tagName, styles } })
        return
      }

      // ── Edit select: iframe sent its current outerHTML for saving ─
      if (msg.type === "__edit_html") {
        const { html } = msg as { html: string }
        const tabId = activeTabIdRef.current
        const state = tabStatesRef.current[tabId]
        const patchedHtml = ensureEditMode(html)
        scheduleArtifactSave({
          artifactId: makeDesignArtifactId(currentSessionIdRef.current, tabId),
          html: patchedHtml,
          workspacePath,
          tabId,
          existingArtifactPath: state?.artifactPath ?? null
        })
        setTabStates((prev) => {
          const state = prev[tabId]
          if (!state) return prev
          if (state.activeVariationId) {
            return {
              ...prev,
              [tabId]: {
                ...state,
                variations: state.variations.map((v) =>
                  v.id === state.activeVariationId ? { ...v, html: patchedHtml } : v
                )
              }
            }
          }
          return { ...prev, [tabId]: { ...state, html: patchedHtml } }
        })
        return
      }

      // ── Edit mode: user changed a value in the Tweaks panel ─
      if (msg.type === "__edit_mode_set_keys") {
        const edits = msg.edits as Record<string, unknown>
        const tabId = activeTabIdRef.current
        const state = tabStatesRef.current[tabId]
        if (!state) return
        const targetHtml = state.activeVariationId
          ? (state.variations.find((v) => v.id === state.activeVariationId)?.html ?? state.html)
          : state.html
        const updated = mergeEditModeKeys(targetHtml, edits)
        scheduleArtifactSave({
          artifactId: makeDesignArtifactId(currentSessionIdRef.current, tabId),
          html: updated,
          workspacePath,
          tabId,
          existingArtifactPath: state.artifactPath
        })
        setTabStates((prev) => {
          const latest = prev[tabId]
          if (!latest) return prev
          // Merge edits into the EDITMODE-BEGIN block of the active HTML
          if (latest.activeVariationId) {
            // Update the specific variation's html
            return {
              ...prev,
              [tabId]: {
                ...latest,
                variations: latest.variations.map((v) =>
                  v.id === latest.activeVariationId ? { ...v, html: updated } : v
                )
              }
            }
          }
          return { ...prev, [tabId]: { ...latest, html: updated } }
        })
        return
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [
    scheduleArtifactSave,
    updatePreviewContentSize,
    updatePreviewScrollState,
    updateTs,
    workspacePath
  ])

  // ── Generate Design ───────────────────────────────────────

  const startGeneration = useCallback(
    (
      prompt: string,
      tabId: string,
      isIteration = false,
      modelId?: string,
      /** Clean user message to append to apiHistory after success (no HTML/suffix) */
      cleanUserMsg?: string,
      image?: { base64: string; mimeType: string },
      skill?: DesignSkillReference | null,
      sourceArtifactPath?: string | null,
      freshAgentThread = false,
      rollbackSnapshot?: DesignIterationRollbackSnapshot | null
    ) => {
      const sessionId = uuid()
      updateTs(tabId, (prev) => ({
        generationState: "generating",
        rightTab: "design",
        pendingApproval: null,
        retryPrompt: prompt,
        retryIsIteration: isIteration,
        retryCleanMsg: cleanUserMsg ?? null,
        retrySkill: skill ?? null,
        messages: [
          ...prev.messages,
          {
            role: "assistant" as const,
            content: "",
            isStreaming: true,
            isIteration,
            executionEvents: []
          }
        ]
      }))

      // Cancel any existing session for this tab before starting a new one.
      cancelDesignRunForTab(tabId)
      tabSessionsRef.current.set(tabId, { cleanup: () => {}, sessionId })

      // Route through the full Agent Runtime: Skills, MCP tools, Hooks, Approvals,
      // context summarisation. Each design session gets an isolated thread.
      const designSessionId = currentSessionIdRef.current
      const agentRuntimeSessionId = freshAgentThread
        ? `retry_${sessionId}_${designSessionId ?? "session"}`
        : designSessionId
      const agentThreadId = makeDesignAgentThreadId(agentRuntimeSessionId, tabId)
      const cleanupApprovalRequest = window.api.sandbox.onApprovalRequest(
        agentThreadId,
        (request) => {
          if (!isCurrentDesignRun(tabId, sessionId, designSessionId)) return
          updateTs(tabId, { pendingApproval: asDesignApprovalRequest(request) })
        }
      )
      const cleanupApprovalTimeout = window.api.sandbox.onApprovalTimeout(agentThreadId, (data) => {
        if (!isCurrentDesignRun(tabId, sessionId, designSessionId)) return
        updateTs(tabId, (prev) => {
          if (prev.pendingApproval?._orchestratorRequestId !== data.requestId) return {}
          return { pendingApproval: null }
        })
      })

      let cleanupStream: (() => void) | null = null
      let cleanedUp = false
      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        cleanupStream?.()
        cleanupApprovalRequest()
        cleanupApprovalTimeout()
      }

      // Stable artifact ID: based on the design session + tab, NOT the streaming session UUID.
      // Using the streaming sessionId (which changes per-call) would create a new artifact
      // directory every generation, making the filesystem-based context chain useless.
      const stableArtifactId = makeDesignArtifactId(currentSessionIdRef.current, tabId)
      const normalizeProgressToken = createDesignProgressNormalizer()
      const runStartState = tabStatesRef.current[tabId]

      const onEvent = async (event: {
        type: string
        token?: string
        html?: string
        error?: string
        event?: unknown
        attempt?: number
        maxRetries?: number
        reason?: string
        delayMs?: number
        artifactPath?: string
        metadata?: unknown
      }) => {
        if (!isCurrentDesignRun(tabId, sessionId, designSessionId)) return

        if (event.type === "model_retry") {
          const retry = asDesignModelRetryState(event)
          if (!retry) return
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.role !== "assistant") return {}
            msgs[last] = { ...msgs[last], modelRetry: retry }
            return { messages: msgs }
          })
          return
        }

        if (event.type === "model_retry_clear") {
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.role !== "assistant" || !msgs[last].modelRetry) return {}
            msgs[last] = { ...msgs[last], modelRetry: null }
            return { messages: msgs }
          })
          return
        }

        if (event.type === "execution") {
          const executionEvent = asDesignExecutionEvent(event.event)
          if (!executionEvent) return
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.role !== "assistant") return {}
            msgs[last] = {
              ...msgs[last],
              executionEvents: appendDesignExecutionEvent(
                msgs[last].executionEvents ?? [],
                executionEvent
              )
            }
            return { messages: msgs }
          })
          return
        }

        if (event.type === "token" && event.token) {
          const progressText = normalizeProgressToken(event.token)
          if (!progressText) return
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.role !== "assistant") return {}
            msgs[last] = {
              ...msgs[last],
              executionEvents: appendDesignExecutionEvent(msgs[last].executionEvents ?? [], {
                kind: "assistant_text",
                id: "assistant-progress",
                content: progressText,
                status: "running",
                timestamp: Date.now()
              })
            }
            return { messages: msgs }
          })
          return
        }

        if (event.type === "done" && event.html) {
          // Guarantee every generated design has a working EDITMODE block
          const runState = tabStatesRef.current[tabId]
          const basePatchedHtml = await prepareHtmlForSrcDoc(event.html, event.artifactPath ?? null)
          const hasDesignSystem = Boolean(runState?.selectedDesignSystemId)
          const patchedHtml = hasDesignSystem
            ? collapseVariationsToSingleArtifact(basePatchedHtml)
            : basePatchedHtml
          const variations = hasDesignSystem ? [] : parseVariations(patchedHtml)
          const selectedDesignSystemForRun =
            designSystems.find((system) => system.id === runState?.selectedDesignSystemId) ?? null
          const artifactMetadata =
            asDesignArtifactMetadata(event.metadata) ??
            buildDesignArtifactMetadata({
              artifactId: stableArtifactId,
              title: cleanUserMsg?.slice(0, 32) || runState?.sourceInfo?.label,
              prompt: cleanUserMsg ?? prompt,
              modelId: modelId ?? null,
              skill: skill ?? null,
              designSystem: selectedDesignSystemForRun,
              sourceInfo: runState?.sourceInfo ?? null,
              html: patchedHtml,
              variations
            })

          // Keep htmlStore in sync (used as fallback / reference)
          window.api.design.storeHtml(stableArtifactId, patchedHtml).catch((err) => {
            console.warn("[Design] storeHtml failed", err)
          })
          if (event.artifactPath) {
            updateTs(tabId, { artifactPath: event.artifactPath, artifactMetadata })
          } else {
            saveDesignArtifactForTab(
              stableArtifactId,
              patchedHtml,
              workspacePath,
              tabId,
              updateTs,
              undefined,
              artifactMetadata
            )
          }

          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            const doneLabel =
              variations.length > 0
                ? `✓ ${isIteration ? "设计已更新" : "设计已生成"} - ${variations.length} 个方案`
                : isIteration
                  ? "✓ 设计已更新"
                  : "✓ 设计已生成"
            if (msgs[last]?.role === "assistant") {
              msgs[last] = {
                ...msgs[last],
                content: doneLabel,
                isStreaming: false,
                modelRetry: null
              }
            }

            // Keep apiHistory in sync for display / session backup
            const prevHistory = prev.apiHistory ?? []
            const newHistory: Array<{ role: "user" | "assistant"; content: string }> = cleanUserMsg
              ? [
                  ...prevHistory,
                  { role: "user" as const, content: cleanUserMsg },
                  { role: "assistant" as const, content: doneLabel }
                ]
              : prevHistory

            return {
              generationState: "done",
              html: patchedHtml,
              messages: msgs,
              variations,
              activeVariationId: variations[0]?.id ?? null,
              artifactMetadata,
              apiHistory: newHistory,
              pendingApproval: null
            }
          })

          if (variations.length > 0) {
            variations.forEach((v) => {
              window.api.design.saveVariant(v.id, v.html).catch((err) => {
                console.warn("[Design] saveVariant failed", err)
              })
            })
          }
          cleanup()
          tabSessionsRef.current.delete(tabId)
        } else if (event.type === "error") {
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.role === "assistant") {
              const prefix = rollbackSnapshot ? "❌ 修改失败，已回滚到修改前版本。" : "❌"
              msgs[last] = {
                ...msgs[last],
                content: `${prefix} ${event.error ?? "Unknown error"}`,
                isStreaming: false,
                modelRetry: null
              }
            }
            return {
              ...(rollbackSnapshot ? restoreIterationRollbackSnapshot(rollbackSnapshot, prev) : {}),
              generationState: "error",
              messages: msgs,
              pendingApproval: null
            }
          })
          cleanup()
          tabSessionsRef.current.delete(tabId)
        } else if (event.type === "cancelled") {
          updateTs(tabId, (prev) => {
            const msgs = [...prev.messages]
            const last = msgs.length - 1
            if (msgs[last]?.isStreaming)
              msgs[last] = { ...msgs[last], isStreaming: false, modelRetry: null }
            return {
              ...(rollbackSnapshot ? restoreIterationRollbackSnapshot(rollbackSnapshot, prev) : {}),
              generationState: "idle",
              messages: msgs,
              pendingApproval: null
            }
          })
          cleanup()
          tabSessionsRef.current.delete(tabId)
        }
      }

      cleanupStream = window.api.design.agentGenerate(
        sessionId,
        prompt,
        onEvent,
        tabId,
        modelId,
        image?.base64,
        image?.mimeType,
        isIteration ? getCurrentDesignHtml(runStartState) : undefined,
        skill ?? undefined,
        workspacePath ?? undefined,
        stableArtifactId,
        sourceArtifactPath ?? undefined,
        agentRuntimeSessionId ?? undefined,
        runStartState?.selectedDesignSystemId ?? undefined
      )
      tabSessionsRef.current.set(tabId, { cleanup, sessionId })
    },
    [cancelDesignRunForTab, designSystems, isCurrentDesignRun, updateTs, workspacePath]
  )

  // ── Ask Questions ─────────────────────────────────────────

  const startAskQuestions = useCallback(
    (prompt: string, tabId: string, modelId?: string, designSystemId?: string | null) => {
      const sessionId = uuid()
      const designSessionId = currentSessionIdRef.current
      updateTs(tabId, {
        generationState: "asking",
        originalPrompt: prompt,
        rightTab: "questions",
        questions: []
      })

      // Cancel any existing session for this tab before starting a new one
      cancelDesignRunForTab(tabId)
      tabSessionsRef.current.set(tabId, { cleanup: () => {}, sessionId })

      const cleanup = window.api.design.askQuestions(
        sessionId,
        prompt,
        (event) => {
          if (!isCurrentDesignRun(tabId, sessionId, designSessionId)) return

          if (event.type === "model_retry") {
            const retry = asDesignModelRetryState(event)
            if (!retry) return
            updateTs(tabId, (prev) => {
              const msgs = [...prev.messages]
              const last = msgs.length - 1
              const lastMessage = msgs[last]
              if (
                lastMessage?.role === "assistant" &&
                lastMessage.isStreaming &&
                lastMessage.modelRetry
              ) {
                msgs[last] = { ...lastMessage, modelRetry: retry }
                return { messages: msgs }
              }
              return {
                messages: [
                  ...prev.messages,
                  { role: "assistant" as const, content: "", isStreaming: true, modelRetry: retry }
                ]
              }
            })
            return
          }

          if (event.type === "model_retry_clear") {
            updateTs(tabId, (prev) => ({
              messages: patchLastAssistantMessage(prev.messages, { modelRetry: null })
            }))
            return
          }

          if (event.type === "done") {
            const qs = Array.isArray(event.questions)
              ? event.questions
                  .map(normalizeQuestionDef)
                  .filter((question): question is QuestionDef => Boolean(question))
              : []
            if (designSystemId && qs.length <= 1) {
              updateTs(tabId, (prev) => ({
                messages: prev.messages.filter(
                  (msg) => !(msg.role === "assistant" && msg.isStreaming && msg.modelRetry)
                ),
                questions: [],
                answers: {},
                rightTab: "design"
              }))
              tabSessionsRef.current.delete(tabId)
              startGeneration(
                buildNewDesignPrompt(
                  `${prompt}\n\n---\nNo clarifying answers were collected because the active design system already fixes visual direction.`,
                  { designSystemId }
                ),
                tabId,
                false,
                modelId,
                prompt
              )
              return
            }
            updateTs(tabId, (prev) => ({
              generationState: "questions_ready",
              questions: qs,
              rightTab: "questions", // re-assert — guards against any interleaved update
              messages: [
                ...prev.messages.filter(
                  (msg) => !(msg.role === "assistant" && msg.isStreaming && msg.modelRetry)
                ),
                { role: "questions-prompt" as const, content: "请补充相关问题 →" }
              ]
            }))
            tabSessionsRef.current.delete(tabId)
          } else if (event.type === "error") {
            updateTs(tabId, (prev) => ({
              generationState: "error",
              messages: [
                ...prev.messages.filter(
                  (msg) => !(msg.role === "assistant" && msg.isStreaming && msg.modelRetry)
                ),
                {
                  role: "assistant" as const,
                  content: `❌ ${event.error ?? "Failed to generate questions"}`
                }
              ]
            }))
            tabSessionsRef.current.delete(tabId)
          }
        },
        modelId,
        designSystemId ?? undefined
      )
      tabSessionsRef.current.set(tabId, { cleanup, sessionId })
    },
    [cancelDesignRunForTab, isCurrentDesignRun, startGeneration, updateTs]
  )

  // ── Generate Design from Screenshot ──────────────────────

  const startGenerationFromImage = useCallback(
    (
      prompt: string,
      imageBase64: string,
      mimeType: string,
      tabId: string,
      modelId?: string,
      designSystemId?: string | null
    ) => {
      const sessionId = uuid()
      const designSessionId = currentSessionIdRef.current
      console.log(
        `[Design:Image] startGenerationFromImage — sessionId=${sessionId} mimeType=${mimeType} base64Len=${imageBase64.length} prompt="${prompt.slice(0, 80)}"`
      )
      updateTs(tabId, (prev) => ({
        generationState: "generating",
        rightTab: "design",
        attachedImage: null, // clear preview once generation starts
        messages: [
          ...prev.messages,
          { role: "assistant" as const, content: "", isStreaming: true, isIteration: false }
        ]
      }))

      cancelDesignRunForTab(tabId)
      tabSessionsRef.current.set(tabId, { cleanup: () => {}, sessionId })

      console.log("[Design:Image] Calling window.api.design.generateFromImage…")
      const cleanup = window.api.design.generateFromImage(
        sessionId,
        prompt,
        imageBase64,
        mimeType,
        (event) => {
          if (!isCurrentDesignRun(tabId, sessionId, designSessionId)) return

          console.log(
            `[Design:Image] Renderer received event: type=${event.type}${event.error ? " error=" + event.error : ""}`
          )
          if (event.type === "model_retry") {
            const retry = asDesignModelRetryState(event)
            if (!retry) return
            updateTs(tabId, (prev) => ({
              messages: patchLastAssistantMessage(prev.messages, { modelRetry: retry })
            }))
            return
          }

          if (event.type === "model_retry_clear") {
            updateTs(tabId, (prev) => ({
              messages: patchLastAssistantMessage(prev.messages, { modelRetry: null })
            }))
            return
          }

          if (event.type === "done" && event.html) {
            const basePatchedHtml = ensureEditMode(event.html)
            const patchedHtml = designSystemId
              ? collapseVariationsToSingleArtifact(basePatchedHtml)
              : basePatchedHtml
            // Store full HTML in main process so subsequent text iterations can reference it
            const storeKey = makeDesignArtifactId(currentSessionIdRef.current, tabId)
            window.api.design.storeHtml(storeKey, patchedHtml).catch((err) => {
              console.warn("[Design] storeHtml failed", err)
            })
            saveDesignArtifactForTab(storeKey, patchedHtml, workspacePath, tabId, updateTs)
            updateTs(tabId, (prev) => {
              const msgs = [...prev.messages]
              const last = msgs.length - 1
              if (msgs[last]?.role === "assistant") {
                msgs[last] = {
                  ...msgs[last],
                  content: "✓ 设计已生成",
                  isStreaming: false,
                  modelRetry: null
                }
              }
              return {
                generationState: "done",
                html: patchedHtml,
                messages: msgs,
                variations: [],
                activeVariationId: null,
                // Seed history so subsequent text iterations have context
                apiHistory: [
                  { role: "user" as const, content: (prompt || "截图设计").slice(0, 200) },
                  { role: "assistant" as const, content: "✓ 设计已生成" }
                ]
              }
            })
            window.api.design.saveVariant("image", patchedHtml).catch((err) => {
              console.warn("[Design] saveVariant failed", err)
            })
            tabSessionsRef.current.delete(tabId)
          } else if (event.type === "error") {
            updateTs(tabId, (prev) => {
              const msgs = [...prev.messages]
              const last = msgs.length - 1
              if (msgs[last]?.role === "assistant") {
                msgs[last] = {
                  ...msgs[last],
                  content: `❌ ${event.error ?? "Unknown error"}`,
                  isStreaming: false,
                  modelRetry: null
                }
              }
              return { generationState: "error", messages: msgs }
            })
            tabSessionsRef.current.delete(tabId)
          } else if (event.type === "cancelled") {
            updateTs(tabId, (prev) => {
              const msgs = [...prev.messages]
              const last = msgs.length - 1
              if (msgs[last]?.isStreaming)
                msgs[last] = { ...msgs[last], isStreaming: false, modelRetry: null }
              return { generationState: "idle", messages: msgs }
            })
            tabSessionsRef.current.delete(tabId)
          }
        },
        modelId,
        designSystemId ?? undefined
      )
      tabSessionsRef.current.set(tabId, { cleanup, sessionId })
    },
    [cancelDesignRunForTab, isCurrentDesignRun, updateTs, workspacePath]
  )

  // ── Handle file input selection (screenshot upload) ───────
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      console.log(
        `[Design:Image] File selected — name="${file.name}" size=${file.size} type="${file.type}"`
      )
      const reader = new FileReader()
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string
        const comma = dataUrl.indexOf(",")
        const header = dataUrl.slice(0, comma)
        const base64 = dataUrl.slice(comma + 1)
        const mimeType = header.match(/data:([^;]+)/)?.[1] ?? "image/png"
        console.log(
          `[Design:Image] File read as base64 — mimeType="${mimeType}" base64Len=${base64.length}`
        )
        updateTs(activeTabId, { attachedImage: { base64, mimeType, previewUrl: dataUrl } })
      }
      reader.onerror = (err) => {
        console.error("[Design:Image] FileReader error:", err)
      }
      reader.readAsDataURL(file)
      // Reset so the same file can be re-selected
      e.target.value = ""
    },
    [activeTabId, updateTs]
  )

  // ── File attachment constants (same as ChatContainer) ─────
  const DESIGN_MAX_ATTACHMENTS = 3
  const DESIGN_MAX_TOTAL_CHARS = 24_000

  const [attachmentLoading, setAttachmentLoading] = useState(false)

  // ── Document attachment — mirrors ChatContainer: uses Electron dialog → file paths ──
  // This avoids the webUtils.getPathForFile reliability issue.
  const handleDocAttach = useCallback(async () => {
    const result = await window.api.file.select()
    if (result.canceled || result.filePaths.length === 0) return

    setAttachmentLoading(true)
    try {
      const currentFiles = tabStates[activeTabId]?.attachedFiles ?? []
      const currentChars = currentFiles.reduce((s, a) => s + a.content.length, 0)
      let remaining = DESIGN_MAX_TOTAL_CHARS - currentChars
      let count = currentFiles.length

      for (const filePath of result.filePaths) {
        if (count >= DESIGN_MAX_ATTACHMENTS) {
          showToast(`最多只能添加 ${DESIGN_MAX_ATTACHMENTS} 个附件`)
          break
        }
        if (remaining <= 0) {
          showToast(`附件总内容已达上限（${DESIGN_MAX_TOTAL_CHARS.toLocaleString()} 字符）`)
          break
        }
        try {
          const res = await window.api.file.parse(filePath, remaining)
          if (res.success && res.attachment) {
            if (!res.attachment.content.trim()) {
              showToast(`"${res.attachment.filename}" 内容为空`)
            } else {
              updateTs(activeTabId, (prev) => ({
                attachedFiles: [...(prev.attachedFiles ?? []), res.attachment!]
              }))
              showToast(`已附加：${res.attachment.filename}`)
              remaining -= res.attachment.content.length
              count++
            }
          } else {
            showToast(res.error ?? "文件解析失败")
          }
        } catch (err) {
          showToast(`解析失败：${err instanceof Error ? err.message : filePath}`)
        }
      }
    } finally {
      setAttachmentLoading(false)
    }
  }, [activeTabId, tabStates, updateTs, showToast])

  // ── Retry last failed generation ─────────────────────────
  const handleRetry = useCallback(() => {
    const state = tabStates[activeTabId]
    if (!state?.retryPrompt) return
    // Remove the last assistant error message before retrying
    updateTs(activeTabId, (prev) => {
      const msgs = [...prev.messages]
      if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") msgs.pop()
      return { messages: msgs, generationState: "idle" }
    })
    startGeneration(
      state.retryPrompt,
      activeTabId,
      state.retryIsIteration,
      state.selectedModelId ?? undefined,
      state.retryCleanMsg ?? undefined,
      undefined,
      state.retrySkill ?? undefined,
      state.artifactPath,
      true,
      state.retryIsIteration ? makeIterationRollbackSnapshot(state) : null
    )
  }, [activeTabId, tabStates, updateTs, startGeneration])

  // ── Build comment prompt helper ───────────────────────────
  // Returns both the instruction prompt (no HTML — main process injects via htmlStore)
  // and the current HTML so the caller can push it to the store.
  const buildCommentPrompt = useCallback(
    (
      comments: {
        elementDesc: string
        text: string
        pageX?: number
        pageY?: number
        anchor?: DesignElementAnchor
      }[],
      state: TabState
    ): { prompt: string } => {
      const activeVarId = state.activeVariationId
      const variantNote = activeVarId ? `\n[正在迭代变体 ${activeVarId.toUpperCase()}。]` : ""
      const commentLines = comments
        .map((c, i) => {
          const anchorText = getAnchoredElementSummary(c.anchor)
          const coordText =
            typeof c.pageX === "number" && typeof c.pageY === "number"
              ? `；坐标 x:${Math.round(c.pageX)}, y:${Math.round(c.pageY)}`
              : ""
          return `[${i + 1}] 元素 (${c.elementDesc}${anchorText ? `；${anchorText}` : ""}${coordText}): ${c.text}`
        })
        .join("\n")

      const prompt = `用户通过 Comment 模式在设计上标注了以下修改意见。请严格按照每条批注对对应元素进行修改，其他部分完全保持不变：

${commentLines}${variantNote}`

      return { prompt }
    },
    []
  )

  // ── Send a single comment directly (without saving to list) ─
  const handleSendDraftComment = useCallback(
    (text: string, elementDesc: string) => {
      const tabId = activeTabId
      const state = tabStates[tabId]
      if (!state || !text.trim()) return

      const draft = state.draftComment
      const { prompt } = buildCommentPrompt(
        [
          {
            elementDesc,
            text,
            pageX: draft?.pageX,
            pageY: draft?.pageY,
            anchor: draft?.anchor
          }
        ],
        state
      )
      const cleanMsg = `📝 ${text.trim().slice(0, 60)}`
      const rollbackSnapshot = makeIterationRollbackSnapshot(state)
      if (rollbackSnapshot && draft) {
        rollbackSnapshot.comments = [
          ...rollbackSnapshot.comments,
          {
            id: uuid(),
            pageX: draft.pageX,
            pageY: draft.pageY,
            text: text.trim(),
            elementDesc,
            anchor: draft.anchor,
            createdAt: Date.now()
          }
        ]
        rollbackSnapshot.draftComment = null
        rollbackSnapshot.activeCommentId = null
      }

      updateTs(tabId, (prev) => ({
        draftComment: null,
        activeCommentId: null,
        messages: [...prev.messages, { role: "user" as const, content: cleanMsg }]
      }))
      startGeneration(
        prompt,
        tabId,
        true,
        state?.selectedModelId ?? undefined,
        cleanMsg,
        undefined,
        undefined,
        state.artifactPath,
        false,
        rollbackSnapshot
      )
    },
    [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt]
  )

  // ── Send a saved comment pin → model ─────────────────────
  const handleSendComment = useCallback(
    (commentId: string, overrideText?: string) => {
      const tabId = activeTabId
      const state = tabStates[tabId]
      if (!state) return

      const comment = state.comments.find((c) => c.id === commentId)
      if (!comment) return

      const text = overrideText ?? comment.text
      const { prompt } = buildCommentPrompt(
        [
          {
            elementDesc: comment.elementDesc,
            text,
            pageX: comment.pageX,
            pageY: comment.pageY,
            anchor: comment.anchor
          }
        ],
        state
      )
      const cleanMsg = `📝 ${text.trim().slice(0, 60)}`
      const rollbackSnapshot = makeIterationRollbackSnapshot(state)

      updateTs(tabId, (prev) => ({
        comments: prev.comments.filter((c) => c.id !== commentId),
        draftComment: null,
        activeCommentId: null,
        messages: [...prev.messages, { role: "user" as const, content: cleanMsg }]
      }))
      startGeneration(
        prompt,
        tabId,
        true,
        state?.selectedModelId ?? undefined,
        cleanMsg,
        undefined,
        undefined,
        state.artifactPath,
        false,
        rollbackSnapshot
      )
    },
    [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt]
  )

  // ── Edit a saved comment's text ───────────────────────────
  const handleEditComment = useCallback(
    (commentId: string, newText: string) => {
      updateTs(activeTabId, (prev) => ({
        comments: prev.comments.map((c) => (c.id === commentId ? { ...c, text: newText } : c))
      }))
    },
    [activeTabId, updateTs]
  )

  // ── Edit select: apply a style property to the selected element live ─
  const handleEditStyleChange = useCallback(
    (property: string, value: unknown) => {
      sendToIframe(iframeRef.current, { type: "__edit_style", property, value })
      // Optimistic UI: update panel immediately without waiting for __edit_click echo
      updateTs(activeTabId, (prev) => {
        if (!prev.selectedElement) return {}
        return {
          selectedElement: {
            ...prev.selectedElement,
            styles: { ...prev.selectedElement.styles, [property]: value } as ElementStyles
          }
        }
      })
    },
    [activeTabId, updateTs]
  )

  // ── Apply ALL saved comments → send to model ─────────────
  const handleApplyComments = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    const pending = state?.comments ?? []
    if (pending.length === 0) return

    const { prompt } = buildCommentPrompt(
      pending.map((c) => ({
        elementDesc: c.elementDesc,
        text: c.text,
        pageX: c.pageX,
        pageY: c.pageY,
        anchor: c.anchor
      })),
      state
    )
    const cleanMsg = `📝 发送 ${pending.length} 条批注`
    const rollbackSnapshot = makeIterationRollbackSnapshot(state)

    updateTs(tabId, (prev) => ({
      comments: [],
      draftComment: null,
      activeCommentId: null,
      messages: [...prev.messages, { role: "user" as const, content: cleanMsg }]
    }))

    startGeneration(
      prompt,
      tabId,
      true,
      state?.selectedModelId ?? undefined,
      cleanMsg,
      undefined,
      undefined,
      state.artifactPath,
      false,
      rollbackSnapshot
    )
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  const collectDrawElementLabels = useCallback((points: DrawPoint[]): string[] => {
    const doc = iframeRef.current?.contentDocument
    const win = iframeRef.current?.contentWindow
    if (!doc || !win || points.length === 0) return []

    const sampleCount = Math.min(6, points.length)
    const step = Math.max(1, Math.floor(points.length / sampleCount))
    const sampledPoints = points.filter((_, index) => index % step === 0).slice(0, sampleCount)
    const seen = new Set<string>()
    sampledPoints.forEach((point) => {
      const element = doc.elementFromPoint(
        Math.round(point.x - win.scrollX),
        Math.round(point.y - win.scrollY)
      )
      const label = getDrawElementLabel(element)
      if (label) seen.add(label)
    })
    return Array.from(seen).slice(0, 8)
  }, [])

  const collectDrawElementHint = useCallback(
    (stroke: DrawStroke): DrawElementHint => {
      return { strokeId: stroke.id, elements: collectDrawElementLabels(stroke.points) }
    },
    [collectDrawElementLabels]
  )

  const handleDrawNoteDraft = useCallback(
    (point: DrawPoint) => {
      const anchor = getPointAnchor(iframeRef.current?.contentDocument ?? null, point)
      updateTs(activeTabId, {
        draftDrawNote: {
          pageX: point.x,
          pageY: point.y,
          anchor,
          elements: anchor?.label ? [anchor.label] : collectDrawElementLabels([point])
        }
      })
    },
    [activeTabId, updateTs, collectDrawElementLabels]
  )

  const handleDrawNoteSubmit = useCallback(
    (text: string) => {
      const value = text.trim()
      if (!value) {
        updateTs(activeTabId, { draftDrawNote: null })
        return
      }
      updateTs(activeTabId, (prev) => {
        if (!prev.draftDrawNote) return {}
        const note: DrawNote = {
          id: uuid(),
          pageX: prev.draftDrawNote.pageX,
          pageY: prev.draftDrawNote.pageY,
          anchor: prev.draftDrawNote.anchor,
          text: value,
          elements: prev.draftDrawNote.elements,
          createdAt: Date.now()
        }
        return {
          drawNotes: [...prev.drawNotes, note],
          draftDrawNote: null
        }
      })
    },
    [activeTabId, updateTs]
  )

  const handleDrawNoteCancel = useCallback(() => {
    updateTs(activeTabId, { draftDrawNote: null })
  }, [activeTabId, updateTs])

  const handleDrawToolModeChange = useCallback(
    (mode: DrawToolMode) => {
      updateTs(activeTabId, { drawToolMode: mode, draftDrawNote: null })
    },
    [activeTabId, updateTs]
  )

  const handleDrawStrokeComplete = useCallback(
    (stroke: DrawStroke) => {
      const doc = iframeRef.current?.contentDocument ?? null
      const anchor = getDominantPointAnchor(doc, stroke.points)
      const anchoredStroke: DrawStroke = {
        ...stroke,
        anchor,
        anchoredPoints: anchor ? anchorPointsForStroke(doc, { ...stroke, anchor }) : undefined
      }
      const hint = collectDrawElementHint(anchoredStroke)
      updateTs(activeTabId, (prev) => ({
        drawStrokes: [...prev.drawStrokes, anchoredStroke],
        drawElementHints: [
          ...prev.drawElementHints.filter((item) => item.strokeId !== anchoredStroke.id),
          hint
        ]
      }))
    },
    [activeTabId, updateTs, collectDrawElementHint]
  )

  const handleUndoDrawStroke = useCallback(() => {
    updateTs(activeTabId, (prev) => {
      const removedStroke = prev.drawStrokes[prev.drawStrokes.length - 1]
      const removedNote = prev.drawNotes[prev.drawNotes.length - 1]
      if (removedNote && (!removedStroke || removedNote.createdAt > removedStroke.createdAt)) {
        return {
          drawNotes: prev.drawNotes.slice(0, -1),
          draftDrawNote: null
        }
      }
      return {
        drawStrokes: prev.drawStrokes.slice(0, -1),
        drawElementHints: removedStroke
          ? prev.drawElementHints.filter((hint) => hint.strokeId !== removedStroke.id)
          : prev.drawElementHints,
        draftDrawNote: null
      }
    })
  }, [activeTabId, updateTs])

  const handleClearDrawStrokes = useCallback(() => {
    updateTs(activeTabId, {
      drawStrokes: [],
      drawElementHints: [],
      drawNotes: [],
      draftDrawNote: null
    })
  }, [activeTabId, updateTs])

  const handleDrawWheel = useCallback(
    (deltaX: number, deltaY: number) => {
      const wrapper = previewScrollRef.current
      const beforeLeft = wrapper?.scrollLeft ?? 0
      const beforeTop = wrapper?.scrollTop ?? 0
      wrapper?.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" })

      const usedX = wrapper ? wrapper.scrollLeft - beforeLeft : 0
      const usedY = wrapper ? wrapper.scrollTop - beforeTop : 0
      const state = tabStatesRef.current[activeTabIdRef.current]
      const scale = Math.max((state?.zoom ?? 100) / 100, 0.25)
      const remainingX = deltaX - usedX
      const remainingY = deltaY - usedY
      if (Math.abs(remainingX) > 0.5 || Math.abs(remainingY) > 0.5) {
        iframeRef.current?.contentWindow?.scrollBy({
          left: remainingX / scale,
          top: remainingY / scale,
          behavior: "auto"
        })
      } else {
        updatePreviewScrollState()
      }
    },
    [updatePreviewScrollState]
  )

  const buildDrawPrompt = useCallback(
    (state: TabState, userInstruction = ""): { prompt: string } => {
      const activeVarId = state.activeVariationId
      const variantNote = activeVarId ? `\n[正在迭代变体 ${activeVarId.toUpperCase()}。]` : ""
      const hintsByStroke = new Map(
        state.drawElementHints.map((hint) => [hint.strokeId, hint.elements])
      )
      const doc = iframeRef.current?.contentDocument ?? null
      const instruction = userInstruction.trim()
      const instructionLine = instruction
        ? `\n用户补充说明：${instruction}\n`
        : "\n用户没有补充文字时，请优先遵循黄色 note 的文本，并把红色绘制区域理解为需要重点优化或修正的 UI 区域。\n"
      const strokeLines = state.drawStrokes
        .filter((stroke) => stroke.points.length > 0)
        .map((stroke, index) => {
          const resolvedPoints = resolveAnchoredStrokePoints(doc, stroke)
          const xs = resolvedPoints.map((point) => point.x)
          const ys = resolvedPoints.map((point) => point.y)
          const minX = Math.round(Math.min(...xs))
          const maxX = Math.round(Math.max(...xs))
          const minY = Math.round(Math.min(...ys))
          const maxY = Math.round(Math.max(...ys))
          const elements = hintsByStroke.get(stroke.id)?.filter(Boolean) ?? []
          const elementText = elements.length > 0 ? `；覆盖/接近元素：${elements.join(", ")}` : ""
          const anchorText = getAnchoredElementSummary(stroke.anchor)
          const orphanText =
            stroke.anchor && resolvedPoints === stroke.points ? "；anchor 未找到，已退回旧坐标" : ""
          return `[${index + 1}] ${stroke.color} 画笔，粗细 ${stroke.width}px，区域 x:${minX}-${maxX}, y:${minY}-${maxY}，${resolvedPoints.length} 个点${elementText}${anchorText ? `；锚点：${anchorText}` : ""}${orphanText}`
        })
        .join("\n")
      const noteLines = state.drawNotes
        .map((note, index) => {
          const elementText =
            note.elements.length > 0 ? `；接近元素：${note.elements.join(", ")}` : ""
          const resolvedPoint = resolveAnchorPagePoint(doc, note.anchor)
          const pageX = resolvedPoint?.x ?? note.pageX
          const pageY = resolvedPoint?.y ?? note.pageY
          const anchorText = getAnchoredElementSummary(note.anchor)
          const orphanText = note.anchor && !resolvedPoint ? "；anchor 未找到，已退回旧坐标" : ""
          return `[${index + 1}] note 坐标 x:${Math.round(pageX)}, y:${Math.round(pageY)}${elementText}${anchorText ? `；锚点：${anchorText}` : ""}${orphanText}\n内容：${note.text}`
        })
        .join("\n")

      const prompt = `用户通过 Draw 模式直接在设计预览上做了标记。请把红色画线理解为视觉指向和编辑意图：线条圈出的、划过的或指向的区域是需要重点调整的区域。黄色 note 是用户在页面任意位置添加的明确文本指令，优先按 note 内容执行。不要把画线或 note 本身渲染进最终页面。请根据标记位置对当前设计做有针对性的视觉优化，保持未标记区域尽量不变。
${instructionLine}

红色绘制标记：
${strokeLines || "无"}

黄色 note：
${noteLines || "无"}${variantNote}`

      return { prompt }
    },
    []
  )

  const handleSendDrawStrokes = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    const annotationCount = (state?.drawStrokes.length ?? 0) + (state?.drawNotes.length ?? 0)
    if (!state || annotationCount === 0) return

    const userInstruction = state.inputValue.trim()
    const { prompt } = buildDrawPrompt(state, userInstruction)
    const cleanMsg = userInstruction
      ? `✏️ ${userInstruction.slice(0, 60)}`
      : `✏️ 发送 ${annotationCount} 条绘制标记`
    const rollbackSnapshot = makeIterationRollbackSnapshot(state)

    updateTs(tabId, (prev) => ({
      inputValue: "",
      drawStrokes: [],
      drawElementHints: [],
      drawNotes: [],
      draftDrawNote: null,
      messages: [...prev.messages, { role: "user" as const, content: cleanMsg }]
    }))

    startGeneration(
      prompt,
      tabId,
      true,
      state?.selectedModelId ?? undefined,
      cleanMsg,
      undefined,
      undefined,
      state.artifactPath,
      false,
      rollbackSnapshot
    )
  }, [activeTabId, tabStates, updateTs, startGeneration, buildDrawPrompt])

  // ── Send message ──────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const prompt = (tabStates[activeTabId]?.inputValue ?? "").trim()
    const attachedImage = tabStates[activeTabId]?.attachedImage ?? null
    const selectedModelId = tabStates[activeTabId]?.selectedModelId ?? undefined
    const selectedSkill = tabStates[activeTabId]?.selectedSkill ?? null
    const codeContext = tabStates[activeTabId]?.codeContext ?? null
    const designLink = tabStates[activeTabId]?.designLink ?? null
    const attachedFiles = tabStates[activeTabId]?.attachedFiles ?? null
    if (!prompt && !attachedImage) return
    const state = tabStates[activeTabId]?.generationState ?? "idle"
    if (state === "asking" || state === "generating") return

    const workspaceRequirementReason = getWorkspaceRequirementReason({
      selectedSkill,
      codeContext,
      prompt
    })
    if (!workspacePath && workspaceRequirementReason) {
      showToast(`${workspaceRequirementReason}，请先选择工作目录。`)
      return
    }

    let syncedContext: DesignContextSyncResult = {}
    try {
      syncedContext = await syncContextFilesToWorkspace({ codeContext, attachedFiles })
    } catch (err) {
      showToast(err instanceof Error ? err.message : "同步上下文文件到工作目录失败")
      return
    }

    // Build the list of file pills to show in the message record before clearing state
    const messageAttachments: MessageAttachment[] = [
      ...(codeContext ?? []).map(
        (f): MessageAttachment => ({
          filename: f.filename,
          kind: "code",
          meta: `${f.content.split("\n").length.toLocaleString()} 行`
        })
      ),
      ...(attachedFiles ?? []).map(
        (f): MessageAttachment => ({
          filename: f.filename,
          kind: "doc",
          meta: `${f.content.length.toLocaleString()} 字符`
        })
      )
    ]

    // Clear transient context after send — skill, files, and code all clear per-send
    updateTs(activeTabId, {
      inputValue: "",
      selectedSkill: null,
      attachedFiles: null,
      codeContext: null
    })

    const tabId = activeTabId
    const stateBeforeSend = tabStates[tabId]
    const hasExistingDesign = hasExistingDesignArtifact(stateBeforeSend)

    // Build context suffixes — included in generation prompt but not displayed in chat
    const designOutputConstraint =
      `IMPORTANT: Regardless of what the skill says about output format, you MUST output a complete standalone ` +
      `<!DOCTYPE html> … </html> file (not a component file, not a code snippet). ` +
      `Because this request explicitly uses a skill, output exactly ONE final design page. ` +
      `Do NOT generate A/B variations, do NOT create elements with id="variation-a" or id="variation-b", ` +
      `and do NOT present alternative versions. ` +
      `The file must include the EDITMODE Tweaks system as required by the system prompt ` +
      `(TWEAK_DEFAULTS with /*EDITMODE-BEGIN*/…/*EDITMODE-END*/ markers, postMessage listener, applyTweaks with CSS variables). ` +
      `Apply the skill's design tokens and patterns inside that HTML file. ` +
      `始终使用中文回答。`
    const skillContext = selectedSkill ? `\n\n---\n${designOutputConstraint}` : ""
    const inlineCodeSuffix =
      codeContext && codeContext.length > 0
        ? "\n\n---\n[Code context — " +
          codeContext.length +
          " file(s)]\n" +
          codeContext
            .map((f) => {
              const ext = f.filename.split(".").pop() ?? ""
              return "```" + ext + "\n// " + f.filename + "\n" + f.content.slice(0, 2000) + "\n```"
            })
            .join("\n\n")
        : ""
    const linkSuffix = designLink
      ? `\n\n---\n[Design reference URL: ${designLink}]\nPlease use this as a visual/layout reference for the design.`
      : ""
    const workspaceFilesSuffix = (() => {
      const lines: string[] = []
      if (syncedContext.attachmentsDir) {
        lines.push(`[Workspace attachment directory]\n${syncedContext.attachmentsDir}`)
        if (syncedContext.attachmentFiles && syncedContext.attachmentFiles.length > 0) {
          lines.push(
            ...syncedContext.attachmentFiles.map((file) => `- ${file.filename}: ${file.targetPath}`)
          )
        }
      }
      if (syncedContext.codeDir) {
        lines.push(`[Workspace code-context directory]\n${syncedContext.codeDir}`)
        if (syncedContext.codeFiles && syncedContext.codeFiles.length > 0) {
          lines.push(
            ...syncedContext.codeFiles.map((file) => `- ${file.filename}: ${file.targetPath}`)
          )
        }
      }
      if (lines.length === 0) return ""
      return (
        "\n\n---\n[Workspace-synced context files]\n" +
        "These files were copied into the current design workspace before this request. " +
        "If you need to inspect or search the uploaded files, use these workspace paths instead of assuming the originals are present.\n" +
        lines.join("\n")
      )
    })()
    const workspaceFileSummarySuffix = selectedSkill
      ? (() => {
          const lines: string[] = []
          if (codeContext && codeContext.length > 0) {
            lines.push(`[Code context summary — ${codeContext.length} file(s)]`)
            lines.push(
              ...codeContext.map((file) => `- ${getPathName(file.filename) || file.filename}`)
            )
          }
          if (attachedFiles && attachedFiles.length > 0) {
            lines.push(`[Attached file summary — ${attachedFiles.length} file(s)]`)
            lines.push(
              ...attachedFiles.map(
                (file) =>
                  `- ${file.filename}${file.truncated ? " (truncated preview available in UI)" : ""}`
              )
            )
          }
          if (lines.length === 0) return ""
          return (
            "\n\n---\n[Context file summary]\n" +
            "These files are available in the synced workspace paths above. Prefer reading/searching those files from the workspace instead of relying on inline prompt copies.\n" +
            lines.join("\n")
          )
        })()
      : ""
    const inlineFilesSuffix =
      attachedFiles && attachedFiles.length > 0
        ? "\n\n---\n[Attached files — " +
          attachedFiles.length +
          " file(s)]\n" +
          attachedFiles
            .map((f) => `### ${f.filename}${f.truncated ? " (truncated)" : ""}\n${f.content}`)
            .join("\n\n")
        : ""
    const contextSuffix =
      skillContext +
      linkSuffix +
      workspaceFilesSuffix +
      workspaceFileSummarySuffix +
      (selectedSkill ? "" : inlineCodeSuffix) +
      (selectedSkill ? "" : inlineFilesSuffix)
    const skillReference = selectedSkill
      ? { name: selectedSkill.name, path: selectedSkill.path }
      : undefined

    // If a screenshot is attached — skip questions. Skill sends still go through
    // Agent Runtime so the selected skill is read/executed and visible in the
    // execution panel; no-skill screenshot sends keep the lean direct vision path.
    if (attachedImage) {
      const userContent = prompt || "请参考截图，生成改进版设计。"
      updateTs(tabId, (prev) => ({
        attachedImage: null,
        messages: [
          ...prev.messages,
          {
            role: "user" as const,
            content: userContent,
            skillName: selectedSkill?.name,
            attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
            imageUrl: attachedImage.previewUrl
          }
        ]
      }))
      if (selectedSkill) {
        startGeneration(
          (prompt || userContent) + contextSuffix,
          tabId,
          false,
          selectedModelId,
          userContent,
          { base64: attachedImage.base64, mimeType: attachedImage.mimeType },
          skillReference,
          tabStates[tabId]?.artifactPath ?? null
        )
      } else {
        startGenerationFromImage(
          prompt + contextSuffix,
          attachedImage.base64,
          attachedImage.mimeType,
          tabId,
          selectedModelId,
          tabStates[tabId]?.selectedDesignSystemId ?? null
        )
      }
      return
    }

    // Always add user message first (skill shown as pill, not embedded in text)
    updateTs(tabId, (prev) => ({
      messages: [
        ...prev.messages,
        {
          role: "user" as const,
          content: prompt,
          skillName: selectedSkill?.name,
          attachments: messageAttachments.length > 0 ? messageAttachments : undefined
        }
      ]
    }))

    // New design requests should use the clarifying-question flow unless a skill
    // is explicitly selected. Chat history alone is not enough to count as an
    // iteration because failed or question-only runs may leave messages without HTML.
    if (!hasExistingDesign) {
      const activeDesignSystemId = tabStates[tabId]?.selectedDesignSystemId ?? null
      if (selectedSkill || shouldSkipDesignQuestions(prompt)) {
        const generationPrompt = selectedSkill
          ? prompt + contextSuffix
          : buildNewDesignPrompt(prompt + contextSuffix, { designSystemId: activeDesignSystemId })
        startGeneration(
          generationPrompt,
          tabId,
          false,
          selectedModelId,
          prompt,
          undefined,
          skillReference
        )
      } else {
        startAskQuestions(prompt + contextSuffix, tabId, selectedModelId, activeDesignSystemId)
      }
    } else {
      // Subsequent messages → iterate on existing design
      const currentState = tabStates[tabId]
      const activeVarId = currentState?.activeVariationId ?? null
      const contextHtml = activeVarId
        ? (currentState?.variations.find((v) => v.id === activeVarId)?.html ??
          currentState?.html ??
          "")
        : (currentState?.html ?? "")

      // ── Multi-turn iteration ──────────────────────────────
      // LangGraph checkpointing (threadId = tabId) automatically provides full
      // conversation history to the model — no need to embed HTML or pass history manually.
      const variantNote = activeVarId
        ? `\n[Iterating on Variation ${activeVarId.toUpperCase()} specifically.]`
        : ""

      const iterationPrompt = `User follow-up instruction: ${prompt}${variantNote}\n\n始终使用中文回答。`
      const artifactPath = currentState?.artifactPath
      const rollbackSnapshot = makeIterationRollbackSnapshot(currentState)

      startGeneration(
        iterationPrompt + contextSuffix,
        tabId,
        /* isIteration */ !!contextHtml,
        selectedModelId,
        prompt, // clean user message for apiHistory recording
        undefined,
        skillReference,
        artifactPath ?? null,
        false,
        rollbackSnapshot
      )
    }
  }, [
    activeTabId,
    tabStates,
    updateTs,
    startAskQuestions,
    startGeneration,
    startGenerationFromImage,
    workspacePath,
    showToast,
    syncContextFilesToWorkspace
  ])

  // ── Continue (submit answers) ─────────────────────────────

  const handleContinue = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state) return

    const { originalPrompt, answers, questions } = state

    // Build enriched prompt with answers
    const answerLines = questions
      .map((q) => {
        const val = answers[q.id]
        if (!val || (Array.isArray(val) && val.length === 0)) return null
        const formatted = Array.isArray(val) ? val.join("、") : val
        return `- ${q.label}: ${formatted}`
      })
      .filter(Boolean)
      .join("\n")

    const enrichedPrompt = answerLines
      ? buildNewDesignPrompt(
          `${originalPrompt}\n\n---\nUser's answers to clarifying questions:\n${answerLines}`,
          { designSystemId: state.selectedDesignSystemId }
        )
      : buildNewDesignPrompt(`${originalPrompt}\n\n---\nNo clarifying answers were provided.`, {
          designSystemId: state.selectedDesignSystemId
        })

    // Build pill tags for the user message update
    const tags = questions
      .map((q) => {
        const val = answers[q.id]
        if (!val || (Array.isArray(val) && val.length === 0)) return null
        return Array.isArray(val) ? val.slice(0, 2).join("、") : val
      })
      .filter((v): v is string => Boolean(v))
      .slice(0, 4)

    // Update the first user message to show answer tags
    updateTs(tabId, (prev) => ({
      messages: prev.messages.map((m, i) => (i === 0 && m.role === "user" ? { ...m, tags } : m)),
      answers
    }))

    // Pass originalPrompt as cleanUserMsg so it's recorded in apiHistory after generation
    startGeneration(
      enrichedPrompt,
      tabId,
      false,
      state.selectedModelId ?? undefined,
      originalPrompt
    )
  }, [activeTabId, tabStates, updateTs, startGeneration])

  const handleCancel = useCallback(() => {
    cancelDesignRunForTab(activeTabId)
    updateTs(activeTabId, { generationState: "idle", pendingApproval: null })
  }, [activeTabId, cancelDesignRunForTab, updateTs])

  const handleDesignApprovalDecision = useCallback(
    (decision: DesignApprovalDecision) => {
      const pendingApproval = tabStates[activeTabId]?.pendingApproval
      if (!pendingApproval) return

      if (pendingApproval._orchestratorRequestId) {
        window.api.sandbox.sendApprovalDecision({
          requestId: pendingApproval._orchestratorRequestId,
          type: decision,
          tool_call_id: pendingApproval.tool_call?.id || ""
        })
      }

      updateTs(activeTabId, { pendingApproval: null })
    },
    [activeTabId, tabStates, updateTs]
  )

  // ── Slash-command skill picker ────────────────────────────
  // Triggered when the input value is just "/" optionally followed by a filter word
  const slashMatch = inputValue.match(/^\/(\S*)$/)
  const isSlashMode = !!slashMatch
  const slashQuery = (slashMatch?.[1] ?? "").toLowerCase()
  const filteredSkills = isSlashMode
    ? allSkills.filter(
        (s) =>
          !slashQuery ||
          s.name.toLowerCase().includes(slashQuery) ||
          (s.scenario ?? "").toLowerCase().includes(slashQuery) ||
          (s.mode ?? "").toLowerCase().includes(slashQuery)
      )
    : []
  const filteredSkillGroups = groupByLabel(filteredSkills, (skill) =>
    skill.source === "template" ? getTemplateModeLabel(skill.mode) : "技能"
  )

  useEffect(() => {
    if (isSlashMode) setActiveSkillIndex(0)
  }, [isSlashMode, slashQuery])

  useEffect(() => {
    if (!isSlashMode) return
    void loadAvailableSkills()
  }, [isSlashMode, loadAvailableSkills])

  useEffect(() => {
    if (!isSlashMode || filteredSkills.length === 0) {
      setActiveSkillIndex(0)
      return
    }
    setActiveSkillIndex((index) => Math.min(index, filteredSkills.length - 1))
  }, [isSlashMode, filteredSkills.length])

  useEffect(() => {
    if (!isSlashMode) return
    skillOptionRefs.current[activeSkillIndex]?.scrollIntoView({ block: "nearest" })
  }, [activeSkillIndex, filteredSkills.length, isSlashMode])

  const handleSkillSelect = useCallback(
    async (skill: SkillInfo) => {
      setInputValue("") // clear "/" from input
      // Optimistically set skill without content first
      updateTs(activeTabId, (prev) => ({ ...prev, selectedSkill: { ...skill } }))
      // Try to load the SKILL.md content
      try {
        const result = await window.api.skills.read(skill.path)
        if (result.success && result.content) {
          updateTs(activeTabId, (prev) => ({
            ...prev,
            selectedSkill:
              prev.selectedSkill?.name === skill.name && prev.selectedSkill?.path === skill.path
                ? { ...prev.selectedSkill, content: result.content }
                : prev.selectedSkill
          }))
        }
      } catch {
        /* skill content optional */
      }
    },
    [activeTabId, updateTs, setInputValue]
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSlashMode) {
      if (e.key === "Escape") {
        e.preventDefault()
        setInputValue("")
        return
      }
      if (e.key === "ArrowDown" && filteredSkills.length > 0) {
        e.preventDefault()
        setActiveSkillIndex((index) => (index + 1) % filteredSkills.length)
        return
      }
      if (e.key === "ArrowUp" && filteredSkills.length > 0) {
        e.preventDefault()
        setActiveSkillIndex((index) => (index - 1 + filteredSkills.length) % filteredSkills.length)
        return
      }
      if (e.key === "Enter" && filteredSkills.length > 0) {
        e.preventDefault()
        handleSkillSelect(filteredSkills[activeSkillIndex] ?? filteredSkills[0])
        return
      }
      return // let other keys type the filter query
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const setAnswer = useCallback(
    (qId: string, value: AnswerValue) => {
      updateTs(activeTabId, (prev) => ({ answers: { ...prev.answers, [qId]: value } }))
    },
    [activeTabId, updateTs]
  )

  const isGenerating = ts.generationState === "generating"
  const isAsking = ts.generationState === "asking"
  const isBlocked = isGenerating || isAsking || ts.generationState === "questions_ready"

  const handleLinkModalConfirm = useCallback(async () => {
    if (linkModalMode === "reference") {
      updateTs(activeTabId, { designLink: linkModalText.trim() })
      setLinkModalOpen(false)
      return
    }

    const imported = await handleImportUrl(
      linkModalText,
      currentSessionId === null ? "gallery" : "session"
    )
    if (imported) {
      setLinkModalOpen(false)
      setLinkModalText("")
    }
  }, [linkModalMode, updateTs, activeTabId, linkModalText, handleImportUrl, currentSessionId])

  const downloadCurrentDesignHtml = useCallback(
    (html: string, metadata?: DesignArtifactMetadata | null) => {
      downloadHtml(html, metadata)
      setExportChoice(null)
    },
    []
  )

  const downloadCurrentDesignPackage = useCallback(
    async (artifactPath: string) => {
      if (exportingPackage) return
      setExportingPackage(true)
      try {
        const result = await window.api.design.exportArtifactPackage(
          artifactPath,
          workspacePath ?? undefined
        )
        if (!result.success || !result.buffer) {
          showToast(result.error || "导出项目包失败")
          return
        }
        downloadBlob(result.buffer, result.fileName || "design.zip", "application/zip")
        setExportChoice(null)
        showToast("项目包已导出")
      } catch (err) {
        showToast(err instanceof Error ? err.message : "导出项目包失败")
      } finally {
        setExportingPackage(false)
      }
    },
    [exportingPackage, showToast, workspacePath]
  )

  const handleExportDesign = useCallback(
    async (state: TabState) => {
      const html = getCurrentDesignHtml(state)
      if (!html.trim()) return

      if (!state.artifactPath) {
        downloadCurrentDesignHtml(html, state.artifactMetadata)
        return
      }

      try {
        const info = await window.api.design.getArtifactPackageInfo(
          state.artifactPath,
          workspacePath ?? undefined
        )
        setExportChoice({
          html,
          artifactPath: info.success ? (info.filePath ?? state.artifactPath) : state.artifactPath,
          relatedFileCount: info.success ? (info.relatedFileCount ?? 0) : 0,
          includesMetadata: Boolean(state.artifactMetadata)
        })
      } catch {
        setExportChoice({
          html,
          artifactPath: state.artifactPath,
          relatedFileCount: 0,
          includesMetadata: Boolean(state.artifactMetadata)
        })
      }
    },
    [downloadCurrentDesignHtml, workspacePath]
  )

  // ── Render ─────────────────────────────────────────────────

  // Show gallery when no session is active
  if (currentSessionId === null) {
    return (
      <>
        <DesignGallery
          sessionIndex={sessionIndex}
          onOpen={openSession}
          onNew={() => setCreateModalOpen(true)}
          onDelete={deleteSession}
          workspacePath={workspacePath}
          workspaceLoading={workspaceLoading}
          onSelectWorkspace={() => {
            void handleSelectWorkspace()
          }}
        />
        <CreateDesignModal
          open={createModalOpen}
          loadingKind={importingSource}
          workspacePath={workspacePath}
          workspaceLoading={workspaceLoading}
          designSystemGroups={designSystemGroups}
          selectedDesignSystemId={createDesignSystemId}
          onSelectWorkspace={() => {
            void handleSelectWorkspace()
          }}
          onDesignSystemChange={setCreateDesignSystemId}
          onCreateBlank={() => {
            createSession(undefined, { designSystemId: createDesignSystemId })
            setCreateModalOpen(false)
          }}
          onImportUrl={() => {
            void openImportUrlModal()
          }}
          onImportHtml={() => {
            void handleImportHtmlFile("gallery")
          }}
          onImportPrototypeZip={() => {
            void handleImportPrototypeZip("gallery")
          }}
          onClose={() => setCreateModalOpen(false)}
        />
        <LinkModal
          open={linkModalOpen}
          mode={linkModalMode}
          url={linkModalText}
          loading={importingSource === "url"}
          onUrlChange={setLinkModalText}
          onConfirm={() => {
            void handleLinkModalConfirm()
          }}
          onClose={() => setLinkModalOpen(false)}
        />
        {toast && (
          <div
            style={{
              position: "fixed",
              bottom: 120,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(30,30,30,0.92)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 500,
              padding: "9px 18px",
              borderRadius: 20,
              zIndex: 99999,
              pointerEvents: "none",
              whiteSpace: "nowrap",
              boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.08)"
            }}
          >
            {toast.msg}
          </div>
        )}
      </>
    )
  }

  return (
    <div style={S.root}>
      <CreateDesignModal
        open={createModalOpen}
        loadingKind={importingSource}
        workspacePath={workspacePath}
        workspaceLoading={workspaceLoading}
        designSystemGroups={designSystemGroups}
        selectedDesignSystemId={createDesignSystemId}
        onSelectWorkspace={() => {
          void handleSelectWorkspace()
        }}
        onDesignSystemChange={setCreateDesignSystemId}
        onCreateBlank={() => {
          newSession(createDesignSystemId)
          setCreateModalOpen(false)
        }}
        onImportUrl={() => {
          void openImportUrlModal()
        }}
        onImportHtml={() => {
          void handleImportHtmlFile("session")
        }}
        onImportPrototypeZip={() => {
          void handleImportPrototypeZip("session")
        }}
        onClose={() => setCreateModalOpen(false)}
      />
      {/* Code & Link modals — rendered at root so they overlay everything */}
      {codeModalOpen && (
        <CodeModal
          initialFiles={ts.codeContext ?? []}
          onConfirm={(files) => {
            updateTs(activeTabId, { codeContext: files.length > 0 ? files : null })
            setCodeModalOpen(false)
          }}
          onClose={() => setCodeModalOpen(false)}
        />
      )}
      <LinkModal
        open={linkModalOpen}
        mode={linkModalMode}
        url={linkModalText}
        loading={importingSource === "url"}
        onUrlChange={setLinkModalText}
        onConfirm={() => {
          void handleLinkModalConfirm()
        }}
        onClose={() => setLinkModalOpen(false)}
      />
      <ExportDesignModal
        open={Boolean(exportChoice)}
        relatedFileCount={exportChoice?.relatedFileCount ?? 0}
        includesMetadata={exportChoice?.includesMetadata ?? false}
        exportingPackage={exportingPackage}
        onExportHtml={() => {
          if (exportChoice) downloadCurrentDesignHtml(exportChoice.html, ts.artifactMetadata)
        }}
        onExportPackage={() => {
          if (exportChoice) void downloadCurrentDesignPackage(exportChoice.artifactPath)
        }}
        onClose={() => {
          if (!exportingPackage) setExportChoice(null)
        }}
      />
      <CustomModelDialog
        open={modelDialogOpen}
        selectedModelId={modelDialogSelectedId}
        showRoutingTier={false}
        onModelSaved={(modelId) => {
          const normalized = normalizeDesignModelId(modelId)
          updateTs(activeTabId, { selectedModelId: normalized })
          try {
            if (normalized) localStorage.setItem(DESIGN_LAST_MODEL_KEY, normalized)
          } catch {
            // Ignore storage errors; the selection still applies to this session.
          }
        }}
        onOpenChange={(open) => {
          setModelDialogOpen(open)
          if (!open) {
            setModelDialogSelectedId(undefined)
            void loadDesignModels()
            void loadModels()
            void loadProviders()
          }
        }}
      />

      {/* Toast notification */}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 120,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(30,30,30,0.92)",
            color: "#fff",
            fontSize: 13,
            fontWeight: 500,
            padding: "9px 18px",
            borderRadius: 20,
            zIndex: 99999,
            pointerEvents: "none",
            whiteSpace: "nowrap",
            boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.08)"
          }}
        >
          {toast.msg}
        </div>
      )}

      {/* Title Bar */}
      <div style={S.titleBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={backToGallery}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 10px 4px 6px",
              background: "none",
              border: "1px solid #d4d2cc",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 500,
              color: "#6a6a6a",
              fontFamily: "inherit",
              lineHeight: 1
            }}
            title="返回历史记录"
          >
            ← 我的设计
          </button>
          <div style={S.logo}>✦</div>
          <span style={S.titleText}>design</span>
          {ts.sourceInfo && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "3px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 700,
                color: "#7a4300",
                background: "#fff2df",
                border: "1px solid #f0d3a6"
              }}
            >
              {getSessionKindLabel(ts.sourceInfo.kind)}
            </span>
          )}
        </div>
        <div style={S.titleActions}>
          {selectedDesignSystem && (
            <span
              title={`设计系统: ${selectedDesignSystem.path}`}
              style={{
                maxWidth: 210,
                height: 30,
                padding: "0 10px",
                border: "1px solid #b9d8cc",
                borderRadius: 8,
                background: "#eef7f3",
                color: "#1f5f4a",
                fontSize: 12,
                fontWeight: 700,
                fontFamily: "inherit",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
            >
              <span style={{ flexShrink: 0 }}>▦</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {selectedDesignSystem.name}
              </span>
            </span>
          )}
          <button
            onClick={handleSelectWorkspace}
            disabled={workspaceLoading || isGenerating}
            style={{
              ...S.workspaceBtn,
              opacity: workspaceLoading ? 0.65 : 1,
              cursor: workspaceLoading || isGenerating ? "default" : "pointer",
              color: workspacePath ? "#1a1a1a" : "#9a5b00",
              borderColor: workspacePath ? "#d4d2cc" : "#e7bf7a",
              background: workspacePath ? "#ffffff" : "#fff7e6"
            }}
            title={
              workspacePath
                ? `工作目录: ${workspacePath}（点击切换）`
                : "选择工作目录（用于保存设计产物）"
            }
          >
            <span style={S.workspaceIcon}>📁</span>
            <span style={S.workspaceText}>
              {workspaceLoading
                ? "选择中..."
                : workspacePath
                  ? getPathName(workspacePath)
                  : "选择工作目录"}
            </span>
          </button>
          <button style={S.shareBtn}>Share</button>
        </div>
      </div>

      <div style={S.mainContent}>
        {/* ── Left Chat Panel ── */}
        <div style={S.leftPanel}>
          {/* Chat Body */}
          <div style={S.chatBody}>
            {ts.messages.length === 0 ? (
              <EmptyState
                onUploadScreenshot={() => fileInputRef.current?.click()}
                onAttachCode={() => setCodeModalOpen(true)}
                onAttachLink={openReferenceLinkModal}
                onImportUrl={openImportUrlModal}
                onImportHtml={() => {
                  void handleImportHtmlFile("session")
                }}
                onImportPrototypeZip={() => {
                  void handleImportPrototypeZip("session")
                }}
              />
            ) : (
              <div ref={messageListRef} style={S.messageList}>
                {ts.messages.map((msg, i) => (
                  <MessageBubble key={i} message={msg} />
                ))}
                {isAsking && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 0",
                      color: "#8a8a8a",
                      fontSize: 13
                    }}
                  >
                    <PulsingDot />
                    <span>正在生成问题…</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Hidden file input — images only (screenshot) */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />

          {/* Bottom Input */}
          <div style={{ ...S.inputArea, position: "relative" }}>
            {/* Skill picker popup — shown when input is "/" + optional filter text */}
            {isSlashMode && filteredSkills.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 4px)",
                  left: 12,
                  right: 12,
                  background: "#ffffff",
                  border: "1px solid #e0ded8",
                  borderRadius: 10,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                  maxHeight: 220,
                  overflowY: "auto",
                  zIndex: 200
                }}
              >
                <div
                  style={{
                    padding: "6px 8px 4px",
                    fontSize: 11,
                    color: "#a0a0a0",
                    fontWeight: 500,
                    borderBottom: "1px solid #f0eee8"
                  }}
                >
                  ▣ 场景模板 / 技能 — ↑↓ 选择，↵ 确认，Esc 取消
                </div>
                {filteredSkillGroups.map((group) => (
                  <div key={group.label}>
                    <div
                      style={{
                        padding: "7px 12px 4px",
                        fontSize: 10,
                        fontWeight: 800,
                        color: "#8a8a8a",
                        textTransform: "uppercase",
                        letterSpacing: 0,
                        background: "#fafaf8",
                        borderBottom: "1px solid #f4f3f0"
                      }}
                    >
                      {group.label}
                    </div>
                    {group.items.map((skill) => {
                      const i = filteredSkills.indexOf(skill)
                      const isActive = i === activeSkillIndex
                      return (
                        <div
                          key={`${skill.source ?? "skill"}:${skill.path}`}
                          ref={(node) => {
                            skillOptionRefs.current[i] = node
                          }}
                          onClick={() => handleSkillSelect(skill)}
                          onMouseEnter={() => setActiveSkillIndex(i)}
                          style={{
                            padding: "8px 12px",
                            cursor: "pointer",
                            background: isActive ? "#f3f2ee" : "transparent",
                            borderBottom:
                              i < filteredSkills.length - 1 ? "1px solid #f4f3f0" : "none",
                            transition: "background 0.1s"
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 14 }}>
                              {skill.source === "template" ? "▣" : "⚡"}
                            </span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a" }}>
                              {skill.name}
                            </span>
                            {skill.source === "template" && (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  color: "#7a4300",
                                  background: "#fff2df",
                                  border: "1px solid #f0d3a6",
                                  borderRadius: 999,
                                  padding: "1px 6px"
                                }}
                              >
                                {getTemplateModeLabel(skill.mode)}
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#8a8a8a",
                              marginTop: 2,
                              marginLeft: 20,
                              lineHeight: 1.4
                            }}
                          >
                            {skill.description.slice(0, 80)}
                            {skill.description.length > 80 ? "…" : ""}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            {isSlashMode && filteredSkills.length === 0 && slashQuery && (
              <div
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 4px)",
                  left: 12,
                  right: 12,
                  background: "#ffffff",
                  border: "1px solid #e0ded8",
                  borderRadius: 10,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                  padding: "10px 14px",
                  fontSize: 12,
                  color: "#a0a0a0",
                  zIndex: 200
                }}
              >
                无匹配技能 — 输入 / 不加文字可查看全部
              </div>
            )}
            <div style={S.inputBox}>
              {/* Screenshot preview strip */}
              {ts.attachedImage && (
                <div
                  style={{ padding: "8px 12px 0", display: "flex", alignItems: "center", gap: 8 }}
                >
                  <div style={{ position: "relative", display: "inline-block" }}>
                    <img
                      src={ts.attachedImage.previewUrl}
                      style={{
                        height: 60,
                        maxWidth: 120,
                        borderRadius: 8,
                        objectFit: "cover",
                        border: "1px solid #e8e6e0",
                        display: "block"
                      }}
                      alt="截图预览"
                    />
                    <button
                      onClick={() => updateTs(activeTabId, { attachedImage: null })}
                      style={{
                        position: "absolute",
                        top: -6,
                        right: -6,
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "#1a1a1a",
                        border: "none",
                        color: "#fff",
                        fontSize: 11,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        lineHeight: 1,
                        fontFamily: "inherit"
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <span style={{ fontSize: 12, color: "#8a8a8a" }}>截图已附加</span>
                </div>
              )}
              {/* Context pills row — skill / code / design-link / attached files */}
              {(selectedDesignSystem ||
                ts.selectedSkill ||
                ts.codeContext ||
                ts.designLink ||
                (ts.attachedFiles && ts.attachedFiles.length > 0)) && (
                <div style={{ padding: "8px 12px 0", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {selectedDesignSystem && (
                    <ContextPill
                      icon="▦"
                      label={selectedDesignSystem.name}
                      badge="DESIGN.md"
                      color={{ bg: "#eef7f3", border: "#b9d8cc", text: "#1f5f4a", dot: "#4b9b7a" }}
                    />
                  )}
                  {ts.selectedSkill && (
                    <ContextPill
                      icon={ts.selectedSkill.source === "template" ? "▣" : "⚡"}
                      label={ts.selectedSkill.name}
                      badge={
                        ts.selectedSkill.source === "template"
                          ? "模板"
                          : ts.selectedSkill.content
                            ? "已加载"
                            : undefined
                      }
                      color={{ bg: "#eff0fb", border: "#c7c9ef", text: "#3a3a8a", dot: "#9090c0" }}
                      onRemove={() => updateTs(activeTabId, { selectedSkill: null })}
                    />
                  )}
                  {ts.codeContext && ts.codeContext.length > 0 && (
                    <ContextPill
                      icon="🗂️"
                      label={
                        ts.codeContext.length === 1
                          ? ts.codeContext[0].filename || "代码"
                          : `${ts.codeContext.length} 个文件`
                      }
                      badge={
                        ts.codeContext.length === 1
                          ? `${ts.codeContext[0].content.split("\n").length} 行`
                          : undefined
                      }
                      color={{ bg: "#f0f8f0", border: "#b8d8b8", text: "#2a5a2a", dot: "#5a9a5a" }}
                      onRemove={() => updateTs(activeTabId, { codeContext: null })}
                      onClick={() => setCodeModalOpen(true)}
                    />
                  )}
                  {ts.designLink && (
                    <ContextPill
                      icon="🔗"
                      label={(() => {
                        try {
                          return new URL(ts.designLink).hostname
                        } catch {
                          return ts.designLink.slice(0, 30)
                        }
                      })()}
                      color={{ bg: "#fff8f0", border: "#e8d0b0", text: "#5a3a00", dot: "#c07820" }}
                      onRemove={() => updateTs(activeTabId, { designLink: null })}
                      onClick={openReferenceLinkModal}
                    />
                  )}
                  {ts.attachedFiles &&
                    ts.attachedFiles.map((f, idx) => (
                      <ContextPill
                        key={f.filePath}
                        icon="📄"
                        label={
                          (f.filename.length > 28
                            ? f.filename.slice(0, 25) +
                              "…" +
                              f.filename.slice(f.filename.lastIndexOf("."))
                            : f.filename) + (f.truncated ? " ⚠️" : "")
                        }
                        badge={`${f.content.length.toLocaleString()} 字符`}
                        color={{
                          bg: "#f5f5ff",
                          border: "#d0d0ef",
                          text: "#3a3a6a",
                          dot: "#9090c0"
                        }}
                        onRemove={() =>
                          updateTs(activeTabId, (prev) => {
                            const remaining = (prev.attachedFiles ?? []).filter((_, i) => i !== idx)
                            return { attachedFiles: remaining.length > 0 ? remaining : null }
                          })
                        }
                      />
                    ))}
                  {ts.attachedFiles && ts.attachedFiles.length > 0 && (
                    <span style={{ fontSize: 11, color: "#aaa", alignSelf: "center" }}>
                      {ts.attachedFiles.length}/{DESIGN_MAX_ATTACHMENTS_DISPLAY} 个文件
                    </span>
                  )}
                </div>
              )}
              {ts.pendingApproval && (
                <DesignApprovalBar
                  approval={ts.pendingApproval}
                  onDecision={handleDesignApprovalDecision}
                />
              )}
              <textarea
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  ts.attachedImage
                    ? "补充说明，如「还原这个页面」或「修改颜色为蓝色」…（可选）"
                    : "描述你想创建的设计… (输入 / 选择技能)"
                }
                rows={2}
                style={S.textarea}
                disabled={isBlocked}
              />
              <div style={S.inputToolbar}>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <ToolbarIcon
                    title="附加文档（txt / md / csv / docx / xlsx）"
                    onClick={handleDocAttach}
                  >
                    {attachmentLoading ? "⏳" : "📎"}
                  </ToolbarIcon>
                  <ToolbarIcon
                    title="关联代码（ts / tsx / js / css / py 等）"
                    onClick={() => setCodeModalOpen(true)}
                  >
                    🗂️
                  </ToolbarIcon>
                  <ToolbarIcon title="上传截图" onClick={() => fileInputRef.current?.click()}>
                    📷
                  </ToolbarIcon>
                  <ModelSelector
                    models={availableModels}
                    selectedId={ts.selectedModelId}
                    onChange={(id) => {
                      const modelId = normalizeDesignModelId(id)
                      updateTs(activeTabId, { selectedModelId: modelId })
                      try {
                        if (modelId) localStorage.setItem(DESIGN_LAST_MODEL_KEY, modelId)
                      } catch {
                        // Ignore storage errors; the selection still applies to this session.
                      }
                    }}
                    onEdit={(id) => {
                      setModelDialogSelectedId(id ?? ts.selectedModelId ?? undefined)
                      setModelDialogOpen(true)
                    }}
                    onAdd={() => {
                      setModelDialogSelectedId(undefined)
                      setModelDialogOpen(true)
                    }}
                  />
                </div>
                {isGenerating ? (
                  <button onClick={handleCancel} style={S.cancelBtn}>
                    ■ 停止
                  </button>
                ) : ts.generationState === "error" && ts.retryPrompt ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={handleRetry}
                      style={{
                        ...S.cancelBtn,
                        background: "#fff3e0",
                        color: "#c05800",
                        border: "1px solid #f0c070"
                      }}
                    >
                      🔄 重试
                    </button>
                    <button
                      onClick={handleSend}
                      disabled={!inputValue.trim() && !ts.attachedImage}
                      style={{
                        ...S.sendBtn,
                        background: inputValue.trim() || ts.attachedImage ? "#cc785c" : "#e8b9a8",
                        cursor: inputValue.trim() || ts.attachedImage ? "pointer" : "default"
                      }}
                    >
                      ▶ 发送
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={(!inputValue.trim() && !ts.attachedImage) || isBlocked}
                    style={{
                      ...S.sendBtn,
                      background:
                        (inputValue.trim() || ts.attachedImage) && !isBlocked
                          ? "#cc785c"
                          : "#e8b9a8",
                      cursor:
                        (inputValue.trim() || ts.attachedImage) && !isBlocked
                          ? "pointer"
                          : "default"
                    }}
                  >
                    ▶ 发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Right Canvas Panel ── */}
        <div style={S.rightPanel}>
          {/* Canvas Tab Bar */}
          <div style={S.canvasBar}>
            <button
              style={S.navBtn}
              title="重新加载预览"
              onClick={() => {
                // Force the iframe back to the design HTML even if it navigated away.
                // Strategy: directly set srcdoc on the DOM element, then bump reloadKey
                // so React also remounts it cleanly on next render.
                const iframe = iframeRef.current
                const state = tabStates[activeTabId]
                if (iframe && state) {
                  const displayHtml = state.activeVariationId
                    ? (state.variations.find((v) => v.id === state.activeVariationId)?.html ??
                      state.html)
                    : state.html
                  if (displayHtml) {
                    iframe.srcdoc = displayHtml
                  }
                }
                updateTs(activeTabId, (prev) => ({ reloadKey: prev.reloadKey + 1 }))
              }}
            >
              ↻
            </button>

            {/* Right panel tabs */}
            <div style={{ display: "flex", gap: 0, marginLeft: 8 }}>
              <RightTabBtn
                label={
                  ts.activeVariationId && ts.variations.length > 0
                    ? (ts.variations.find((v) => v.id === ts.activeVariationId)?.label ?? "设计")
                    : "设计"
                }
                active={ts.rightTab === "design"}
                onClick={() => updateTs(activeTabId, { rightTab: "design" })}
              />
              {(ts.generationState === "asking" || ts.generationState === "questions_ready") && (
                <RightTabBtn
                  label="问题"
                  active={ts.rightTab === "questions"}
                  onClick={() => updateTs(activeTabId, { rightTab: "questions" })}
                  closable
                />
              )}
            </div>

            <div style={{ flex: 1 }} />

            {/* Top-bar tools — tweaks toggle + mode buttons + zoom + export */}
            {ts.html && ts.rightTab === "design" && (
              <div style={S.tweaksBar}>
                {/* Tweaks toggle */}
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: tweaksOn ? "#1a1a1a" : "#8a8a8a"
                    }}
                  >
                    微调
                  </span>
                  <button
                    onClick={() => {
                      setTweaksOn((v) => !v)
                      setActiveMode(null)
                    }}
                    style={{ ...S.toggleTrack, background: tweaksOn ? "#1a1a1a" : "#d4d2cc" }}
                    title={tweaksOn ? "关闭微调" : "开启微调"}
                  >
                    <span
                      style={{
                        ...S.toggleThumb,
                        transform: tweaksOn ? "translateX(14px)" : "translateX(0)"
                      }}
                    />
                  </button>
                </div>

                {tweaksOn && (
                  <>
                    <div style={S.tweaksDivider} />
                    <TweaksBtn
                      label="注释"
                      icon={<CommentIcon active={activeMode === "comment"} />}
                      active={activeMode === "comment"}
                      onClick={() => setActiveMode(activeMode === "comment" ? null : "comment")}
                    />
                    <TweaksBtn
                      label="编辑"
                      icon={<EditIcon active={activeMode === "edit"} />}
                      active={activeMode === "edit"}
                      onClick={() => setActiveMode(activeMode === "edit" ? null : "edit")}
                    />
                    <TweaksBtn
                      label="绘制"
                      icon={<DrawIcon active={activeMode === "draw"} />}
                      active={activeMode === "draw"}
                      onClick={() => setActiveMode(activeMode === "draw" ? null : "draw")}
                    />
                  </>
                )}

                <div style={S.tweaksDivider} />
                {/* Zoom */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => setZoom((z) => Math.max(25, z - 25))} style={S.zoomBtn}>
                    −
                  </button>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: "#4a4a4a",
                      minWidth: 36,
                      textAlign: "center"
                    }}
                  >
                    {zoom}%
                  </span>
                  <button onClick={() => setZoom((z) => Math.min(200, z + 25))} style={S.zoomBtn}>
                    +
                  </button>
                </div>
                <div style={S.tweaksDivider} />
                <button
                  style={S.canvasActionBtn}
                  onClick={() => {
                    void handleExportDesign(ts)
                  }}
                >
                  ⬇ 导出
                </button>
              </div>
            )}
          </div>

          {/* Canvas Content */}
          <div style={S.canvas}>
            {ts.rightTab === "questions" ? (
              /* ── Questions Form ── */
              <QuestionsPanel
                questions={ts.questions}
                answers={ts.answers}
                isLoading={ts.generationState === "asking"}
                onAnswer={setAnswer}
                onContinue={handleContinue}
                onSkip={handleContinue}
              />
            ) : (
              /* ── Design Preview ── */
              <>
                {isGenerating && !ts.html ? (
                  <div style={S.canvasEmpty}>
                    <div style={S.generatingRow}>
                      <PulsingDot />
                      <span style={{ fontSize: 14, color: "#8a8a8a" }}>正在生成方案…</span>
                    </div>
                  </div>
                ) : ts.html ? (
                  (() => {
                    // Resolve which HTML to show: active variation or full HTML
                    const displayHtml = ts.activeVariationId
                      ? (ts.variations.find((v) => v.id === ts.activeVariationId)?.html ?? ts.html)
                      : ts.html
                    const activeVar = ts.variations.find((v) => v.id === ts.activeVariationId)
                    const varColor =
                      ts.activeVariationId === "a"
                        ? "#3b82f6"
                        : ts.activeVariationId === "b"
                          ? "#8b5cf6"
                          : ts.activeVariationId === "c"
                            ? "#f59e0b"
                            : undefined
                    const iframeDoc = iframeRef.current?.contentDocument ?? null
                    const visibleWidth = canvasContainerRef.current?.clientWidth || 800
                    const visibleHeight = canvasContainerRef.current?.clientHeight || 600
                    const scaledContentWidth =
                      Math.max(visibleWidth / (zoom / 100), ts.iframeContentWidth || 0) *
                      (zoom / 100)
                    const scaledContentHeight =
                      Math.max(visibleHeight / (zoom / 100), ts.iframeContentHeight || 0) *
                      (zoom / 100)
                    const resolvedDrawStrokes: ResolvedDrawStroke[] = ts.drawStrokes.map(
                      (stroke) => {
                        const resolvedPoints = resolveAnchoredStrokePoints(iframeDoc, stroke)
                        return {
                          ...stroke,
                          resolvedPoints,
                          orphaned: Boolean(stroke.anchor && resolvedPoints === stroke.points)
                        }
                      }
                    )
                    const resolvedDrawNotes: ResolvedDrawNote[] = ts.drawNotes.map((note) => {
                      const resolvedPoint =
                        resolveAnchorPagePoint(iframeDoc, note.anchor) ?? undefined
                      return {
                        ...note,
                        resolvedPoint,
                        orphaned: Boolean(note.anchor && !resolvedPoint)
                      }
                    })
                    const draftDrawPoint = resolveAnchorPagePoint(
                      iframeDoc,
                      ts.draftDrawNote?.anchor
                    )
                    const resolvedDraftDrawNote: ResolvedDraftDrawNote | null = ts.draftDrawNote
                      ? {
                          ...ts.draftDrawNote,
                          resolvedPoint: draftDrawPoint ?? undefined,
                          orphaned: Boolean(ts.draftDrawNote.anchor && !draftDrawPoint)
                        }
                      : null

                    return (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "flex",
                          flexDirection: "row"
                        }}
                      >
                        <div
                          ref={canvasContainerRef}
                          style={{ position: "relative", flex: 1, minWidth: 0, height: "100%" }}
                          onClick={() => {
                            if (ts.activeCommentId) updateTs(activeTabId, { activeCommentId: null })
                          }}
                        >
                          {/* Iteration in-progress banner */}
                          {isGenerating && (
                            <div
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                right: 0,
                                zIndex: 10,
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 16px",
                                background: "rgba(26,26,26,0.82)",
                                backdropFilter: "blur(6px)",
                                color: "#ffffff",
                                fontSize: 13,
                                fontWeight: 500
                              }}
                            >
                              <PulsingDot />
                              <span>正在更新设计…下方显示上一版</span>
                              <button
                                onClick={handleCancel}
                                style={{
                                  marginLeft: "auto",
                                  padding: "3px 12px",
                                  fontSize: 12,
                                  fontWeight: 600,
                                  background: "rgba(255,255,255,0.15)",
                                  border: "1px solid rgba(255,255,255,0.25)",
                                  borderRadius: 6,
                                  color: "#fff",
                                  cursor: "pointer"
                                }}
                              >
                                停止
                              </button>
                            </div>
                          )}
                          {/* Active variation label badge */}
                          {activeVar && !isGenerating && (
                            <div
                              style={{
                                position: "absolute",
                                top: 12,
                                right: 16,
                                zIndex: 5,
                                padding: "4px 12px",
                                borderRadius: 999,
                                fontSize: 12,
                                fontWeight: 600,
                                background: varColor,
                                color: "#fff",
                                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                                pointerEvents: "none"
                              }}
                            >
                              {activeVar.label}
                            </div>
                          )}
                          {/* Scroll wrapper — overflow lives here so the iframe's height: 100% resolves
                        against canvasContainerRef (which has explicit height: "100%") rather than
                        an overflow:auto ancestor (which breaks CSS % height resolution in Chromium). */}
                          <div
                            ref={previewScrollRef}
                            style={{ position: "absolute", inset: 0, overflow: "auto" }}
                            onScroll={() => updatePreviewScrollState()}
                          >
                            <div
                              style={{
                                position: "relative",
                                width: scaledContentWidth,
                                height: scaledContentHeight,
                                minWidth: "100%",
                                minHeight: "100%"
                              }}
                            >
                              <iframe
                                ref={iframeRef}
                                key={`${ts.activeVariationId ?? "all"}-${ts.reloadKey}`}
                                srcDoc={displayHtml}
                                style={{
                                  display: "block",
                                  position: "absolute",
                                  left: 0,
                                  top: 0,
                                  border: "none",
                                  transformOrigin: "top left",
                                  transform: `scale(${zoom / 100})`,
                                  width: Math.max(
                                    visibleWidth / (zoom / 100),
                                    ts.iframeContentWidth || 0
                                  ),
                                  height: Math.max(
                                    visibleHeight / (zoom / 100),
                                    ts.iframeContentHeight || 0
                                  ),
                                  // Comment + Edit modes need pointer events (scripts handle clicks via postMessage)
                                  pointerEvents:
                                    activeMode === null ||
                                    activeMode === "comment" ||
                                    activeMode === "edit"
                                      ? "auto"
                                      : "none"
                                }}
                                sandbox="allow-scripts allow-same-origin"
                                title="Design Preview"
                                onLoad={() => {
                                  // Block link/form navigation so clicks inside the preview
                                  // never navigate the iframe away from the design
                                  injectIntoIframe(iframeRef.current, NAV_BLOCK_INJECT)
                                  // Always inject scroll tracker so pins stay anchored to content
                                  injectIntoIframe(iframeRef.current, SCROLL_INJECT)
                                  // Reset scroll state — new iframe always starts at (0, 0)
                                  updateTs(activeTabId, {
                                    iframeScrollX: 0,
                                    iframeScrollY: 0,
                                    iframeContentWidth: 0,
                                    iframeContentHeight: 0,
                                    selectedElement: null
                                  })
                                  if (previewScrollRef.current) {
                                    previewScrollRef.current.scrollLeft = 0
                                    previewScrollRef.current.scrollTop = 0
                                  }
                                  // Re-inject mode scripts after iframe reloads (variation switch, etc.)
                                  if (activeMode === "comment")
                                    injectIntoIframe(iframeRef.current, COMMENT_INJECT)
                                  if (activeMode === "edit")
                                    injectIntoIframe(iframeRef.current, EDIT_SELECT_INJECT)
                                }}
                              />
                            </div>
                          </div>
                          {(activeMode === "draw" ||
                            ts.drawStrokes.length > 0 ||
                            ts.drawNotes.length > 0) && (
                            <DrawLayer
                              key={activeMode === "draw" ? "draw-active" : "draw-idle"}
                              active={activeMode === "draw"}
                              mode={ts.drawToolMode}
                              strokes={resolvedDrawStrokes}
                              notes={resolvedDrawNotes}
                              draftNote={resolvedDraftDrawNote}
                              zoom={zoom}
                              scrollX={ts.iframeScrollX}
                              scrollY={ts.iframeScrollY}
                              onStrokeComplete={handleDrawStrokeComplete}
                              onNoteDraft={handleDrawNoteDraft}
                              onNoteSubmit={handleDrawNoteSubmit}
                              onNoteCancel={handleDrawNoteCancel}
                              onWheelScroll={handleDrawWheel}
                            />
                          )}

                          {activeMode === "draw" && (
                            <DrawActionBar
                              mode={ts.drawToolMode}
                              count={ts.drawStrokes.length + ts.drawNotes.length}
                              onModeChange={handleDrawToolModeChange}
                              onClose={() => setActiveMode(null)}
                              onUndo={handleUndoDrawStroke}
                              onClear={handleClearDrawStrokes}
                              onSend={handleSendDrawStrokes}
                            />
                          )}
                          {/* ── Comment layer ── */}
                          {/* No click overlay needed — iframe script handles clicks via postMessage */}

                          {/* Existing comment pins — always visible while comment mode or there are comments */}
                          {(activeMode === "comment" || ts.comments.length > 0) &&
                            (() => {
                              const zf = zoom / 100
                              const cw = canvasContainerRef.current?.clientWidth || 800
                              const ch = canvasContainerRef.current?.clientHeight || 600
                              return ts.comments.map((c, i) => {
                                const anchoredPoint = resolveAnchorPagePoint(iframeDoc, c.anchor)
                                const pageX = anchoredPoint?.x ?? c.pageX
                                const pageY = anchoredPoint?.y ?? c.pageY
                                // Convert document-absolute coords to current canvas-relative % via scroll offset
                                const pinLeft = (((pageX - ts.iframeScrollX) * zf) / cw) * 100
                                const pinTop = (((pageY - ts.iframeScrollY) * zf) / ch) * 100
                                // Hide pins that have scrolled out of the visible canvas area
                                const inView =
                                  pinLeft > -6 && pinLeft < 106 && pinTop > -6 && pinTop < 106
                                if (!inView) return null
                                return (
                                  <CommentPin
                                    key={c.id}
                                    comment={c}
                                    index={i + 1}
                                    pinLeft={pinLeft}
                                    pinTop={pinTop}
                                    viewportWidth={cw}
                                    viewportHeight={ch}
                                    isActive={ts.activeCommentId === c.id}
                                    onToggle={() =>
                                      updateTs(activeTabId, {
                                        activeCommentId: ts.activeCommentId === c.id ? null : c.id,
                                        draftComment: null
                                      })
                                    }
                                    onSend={(text) => handleSendComment(c.id, text)}
                                    onEdit={(newText) => handleEditComment(c.id, newText)}
                                  />
                                )
                              })
                            })()}

                          {/* Draft comment input — shown after clicking canvas */}
                          {ts.draftComment &&
                            (() => {
                              const zf = zoom / 100
                              const cw = canvasContainerRef.current?.clientWidth || 800
                              const ch = canvasContainerRef.current?.clientHeight || 600
                              const anchoredPoint = resolveAnchorPagePoint(
                                iframeDoc,
                                ts.draftComment.anchor
                              )
                              const pageX = anchoredPoint?.x ?? ts.draftComment.pageX
                              const pageY = anchoredPoint?.y ?? ts.draftComment.pageY
                              const draftLeft = Math.min(
                                95,
                                Math.max(2, (((pageX - ts.iframeScrollX) * zf) / cw) * 100)
                              )
                              const draftTop = Math.min(
                                95,
                                Math.max(2, (((pageY - ts.iframeScrollY) * zf) / ch) * 100)
                              )
                              return (
                                <CommentDraftInput
                                  x={draftLeft}
                                  y={draftTop}
                                  viewportWidth={cw}
                                  viewportHeight={ch}
                                  elementDesc={ts.draftComment.elementDesc}
                                  onSubmit={(text) => {
                                    if (!text.trim()) {
                                      updateTs(activeTabId, { draftComment: null })
                                      return
                                    }
                                    const newComment: CommentItem = {
                                      id: uuid(),
                                      pageX: ts.draftComment!.pageX,
                                      pageY: ts.draftComment!.pageY,
                                      text: text.trim(),
                                      elementDesc: ts.draftComment!.elementDesc,
                                      anchor: ts.draftComment!.anchor,
                                      createdAt: Date.now()
                                    }
                                    updateTs(activeTabId, (prev) => ({
                                      comments: [...prev.comments, newComment],
                                      draftComment: null,
                                      activeCommentId: newComment.id
                                    }))
                                  }}
                                  onSend={(text) => {
                                    if (!text.trim()) return
                                    const draft = ts.draftComment!
                                    handleSendDraftComment(text, draft.elementDesc)
                                  }}
                                  onCancel={() => updateTs(activeTabId, { draftComment: null })}
                                />
                              )
                            })()}

                          {/* Comment bottom bar: hint when empty, Apply bar when there are comments */}
                          {activeMode === "comment" && !ts.draftComment && (
                            <div
                              style={{
                                position: "absolute",
                                bottom: 20,
                                left: "50%",
                                transform: "translateX(-50%)",
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: ts.comments.length > 0 ? "8px 8px 8px 16px" : "6px 16px",
                                borderRadius: 999,
                                background: "rgba(26,26,26,0.82)",
                                backdropFilter: "blur(8px)",
                                boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                                whiteSpace: "nowrap"
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 500,
                                  color: ts.comments.length > 0 ? "#d1d5db" : "#fff"
                                }}
                              >
                                {ts.comments.length === 0
                                  ? "点击元素添加批注"
                                  : ts.comments.length === 1
                                    ? "1 条批注已保存"
                                    : `${ts.comments.length} 条批注已保存`}
                              </span>
                              {ts.comments.length > 1 && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleApplyComments()
                                  }}
                                  style={{
                                    padding: "5px 14px",
                                    borderRadius: 999,
                                    background: "#cc785c",
                                    border: "none",
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: "#fff",
                                    cursor: "pointer",
                                    fontFamily: "inherit"
                                  }}
                                >
                                  发送全部 →
                                </button>
                              )}
                            </div>
                          )}

                          {/* Floating Tweaks Panel — bottom-right variation switcher */}
                          {ts.variations.length > 0 && !isGenerating && (
                            <TweaksFloatingPanel
                              variations={ts.variations}
                              activeId={ts.activeVariationId}
                              position={ts.variationPanelPosition}
                              onPositionChange={(position) =>
                                updateTs(activeTabId, { variationPanelPosition: position })
                              }
                              onSelect={(id) =>
                                updateTs(activeTabId, { activeVariationId: id, rightTab: "design" })
                              }
                            />
                          )}
                        </div>

                        {/* ── Right Properties Panel (Edit mode) ── */}
                        {activeMode === "edit" && (
                          <ElementPropsPanel
                            key={ts.selectedElement?.edId ?? "none"}
                            selectedElement={ts.selectedElement}
                            onStyleChange={handleEditStyleChange}
                          />
                        )}
                      </div>
                    )
                  })()
                ) : (
                  <div style={S.canvasEmpty}>
                    <p style={S.canvasEmptyText}>生成的设计将在此展示</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────

function downloadHtml(html: string, metadata?: DesignArtifactMetadata | null) {
  const metadataScript = metadata
    ? `\n<script type="application/design-artifact+json">${JSON.stringify({ ...metadata, exportedAt: new Date().toISOString() }).replace(/<\/script/gi, "<\\/script")}</script>`
    : ""
  const output = metadataScript
    ? /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${metadataScript}\n</body>`)
      : `${html}${metadataScript}`
    : html
  const blob = new Blob([output], { type: "text/html" })
  downloadBlob(blob, "design.html", "text/html")
}

function downloadBlob(data: BlobPart, filename: string, type: string) {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
