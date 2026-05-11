import React, { useState, useRef, useCallback, useEffect } from "react"
import { v4 as uuid } from "uuid"
import { inlineHtmlSiblingAssets } from "@/lib/html-srcdoc"
import { CodeModal } from "./CodeModal"
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
  TweaksBtn,
} from "./DesignControls"
import { CommentDraftInput, CommentPin } from "./DesignComments"
import { DrawActionBar, DrawLayer } from "./DesignDraw"
import { DesignGallery } from "./DesignGallery"
import { CreateDesignModal, LinkModal } from "./DesignModals"
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
  DesignExecutionEvent,
  DesignModelRetryState,
  DesignSessionKind,
  DesignSkillReference,
  DesignSourceInfo,
  DrawElementHint,
  DrawNote,
  DrawPoint,
  DrawStroke,
  DrawToolMode,
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
  VariationItem,
} from "./types"
import {
  SINGLE_DESIGN_TAB_ID,
  SINGLE_DESIGN_TAB_LABEL,
} from "./types"

function getPathName(filePath: string | null): string {
  if (!filePath) return ""
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

function getSessionKindLabel(kind: DesignSessionKind | DesignSourceInfo["kind"] | undefined): string {
  switch (kind) {
    case "import_url":
      return "链接还原"
    case "import_html":
      return "HTML 导入"
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
    editModeAvailable: false,
    selectedElement: null,
    attachedImage: null,
    selectedModelId: getLastModelId(),  // default to last-used model
    reloadKey: 0,
    selectedSkill: null,
    codeContext: null,
    designLink: null,
    attachedFiles: null,
    retryPrompt: null,
    retryIsIteration: false,
    retryCleanMsg: null,
    retrySkill: null,
    artifactPath: null,
    variationPanelPosition: null,
    apiHistory: [],
    pendingApproval: null,
  }
}

function makeDesignAgentThreadId(designSessionId: string | null, tabId: string): string {
  const safeSessionId = String(designSessionId || "session")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "session"
  const safeTabId = String(tabId || "tab")
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

function hydrateTabStateHtml(state: TabState, html: string): TabState {
  const patchedHtml = ensureEditMode(html)
  const variations = parseVariations(patchedHtml)
  return {
    ...state,
    html: patchedHtml,
    variations,
    activeVariationId: state.activeVariationId && variations.some((v) => v.id === state.activeVariationId)
      ? state.activeVariationId
      : variations[0]?.id ?? null,
    reloadKey: state.reloadKey + 1,
  }
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
    "apply patch",
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

function saveDesignArtifactForTab(
  artifactId: string,
  html: string,
  workspacePath: string | null,
  tabId: string,
  updateTs: (tabId: string, patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void,
  existingArtifactPath?: string | null
): void {
  if (!html.trim()) return
  if (!workspacePath) return
  const savePromise = existingArtifactPath
    ? window.api.design.saveArtifactFile(existingArtifactPath, html, workspacePath ?? undefined)
    : window.api.design.saveArtifact(artifactId, html, workspacePath ?? undefined)
  savePromise
    .then(async (result) => {
      if (!result.success && existingArtifactPath) {
        result = await window.api.design.saveArtifact(artifactId, html, workspacePath ?? undefined)
      }
      if (result.success && result.filePath) {
        window.api.design.storeHtml(artifactId, html).catch(() => {})
        updateTs(tabId, { artifactPath: result.filePath })
      }
    })
    .catch(() => {
      if (existingArtifactPath) {
        window.api.design.saveArtifact(artifactId, html, workspacePath ?? undefined)
          .then((result) => {
            if (result.success && result.filePath) {
              window.api.design.storeHtml(artifactId, html).catch(() => {})
              updateTs(tabId, { artifactPath: result.filePath })
            }
          })
          .catch(() => {})
      }
    })
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
      ? req.allowed_approval_types as DesignApprovalDecision[]
      : undefined,
  } as DesignApprovalRequest
}

function asDesignExecutionEvent(event: unknown): DesignExecutionEvent | null {
  if (!event || typeof event !== "object") return null
  const raw = event as Partial<DesignExecutionEvent>
  if (raw.kind !== "tool_call" && raw.kind !== "tool_result" && raw.kind !== "used_skill") return null
  return {
    kind: raw.kind,
    id: typeof raw.id === "string" ? raw.id : undefined,
    toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : undefined,
    name: typeof raw.name === "string" ? raw.name : undefined,
    args: raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
      ? raw.args
      : undefined,
    content: typeof raw.content === "string" ? raw.content : undefined,
    isError: raw.isError === true,
    status: raw.status === "success" || raw.status === "error" || raw.status === "running"
      ? raw.status
      : raw.kind === "tool_result"
        ? raw.isError ? "error" : "success"
        : "running",
    timestamp: typeof raw.timestamp === "number" ? raw.timestamp : Date.now(),
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
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0,
  }
}

function patchLastAssistantMessage(
  messages: Message[],
  patch: Partial<Message>
): Message[] {
  const next = [...messages]
  const last = next.length - 1
  if (next[last]?.role !== "assistant") return messages
  next[last] = { ...next[last], ...patch }
  return next
}

function appendDesignExecutionEvent(events: DesignExecutionEvent[], event: DesignExecutionEvent): DesignExecutionEvent[] {
  if (event.kind === "used_skill") {
    if (!event.name) {
      return events
    }
    const index = events.findIndex((item) => item.kind === "used_skill" && item.name === event.name)
    if (index < 0) return [...events, event]
    const next = [...events]
    const current = next[index]
    const shouldKeepCompletedStatus = (current.status === "success" || current.status === "error") && event.status === "running"
    next[index] = {
      ...current,
      ...event,
      status: shouldKeepCompletedStatus ? current.status : event.status,
      isError: shouldKeepCompletedStatus ? current.isError : event.isError,
    }
    return next
  }

  if (event.kind === "tool_call") {
    const toolCallId = event.toolCallId || event.id
    if (toolCallId && events.some((item) => item.kind === "tool_call" && (item.toolCallId || item.id) === toolCallId)) {
      return events
    }
    return [...events, event]
  }

  const resultKey = event.id || event.toolCallId
  if (resultKey && events.some((item) => item.kind === "tool_result" && (item.id || item.toolCallId) === resultKey)) {
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
      const stubs = otherIds.map((v) => `<div id="variation-${v}" style="display:none!important;visibility:hidden!important;position:absolute!important;pointer-events:none!important"></div>`).join("\n")

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

// File attachment limits — mirrors ChatContainer
const DESIGN_MAX_ATTACHMENTS_DISPLAY = 3

// Last-used model persistence
const DESIGN_LAST_MODEL_KEY = "design_last_model_id"
function getLastModelId(): string | null {
  try { return localStorage.getItem(DESIGN_LAST_MODEL_KEY) } catch { return null }
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
  rightTab: RightPanelTab
  apiHistory?: Array<{ role: "user" | "assistant"; content: string }>
  artifactPath?: string | null
  variationPanelPosition?: FloatingPanelPosition | null
}

interface PersistedSession {
  chatTabs: ChatTab[]
  activeTabId: string
  tabStates: Record<string, PersistedTabState>
}

function serializeTs(ts: TabState): PersistedTabState {
  return {
    messages:          ts.messages,
    html:              ts.html.slice(0, MAX_HTML_BYTES),
    sourceInfo:        ts.sourceInfo,
    variations:        ts.variations.map((v) => ({ id: v.id, label: v.label, html: v.html.slice(0, MAX_HTML_BYTES) })),
    activeVariationId: ts.activeVariationId,
    selectedModelId:   ts.selectedModelId,
    tweaksOn:          ts.tweaksOn,
    zoom:              ts.zoom,
    comments:          ts.comments,
    drawStrokes:       ts.drawStrokes,
    drawElementHints:  ts.drawElementHints,
    drawNotes:         ts.drawNotes,
    drawToolMode:      ts.drawToolMode,
    codeContext:       ts.codeContext,
    designLink:        ts.designLink,
    rightTab:          ts.rightTab,
    apiHistory:        ts.apiHistory,
    artifactPath:      ts.artifactPath,
    variationPanelPosition: ts.variationPanelPosition,
  }
}

function deserializeTs(p: PersistedTabState): TabState {
  return {
    ...makeTabState(),
    ...p,
    sourceInfo:      p.sourceInfo ?? null,
    drawStrokes:     p.drawStrokes ?? [],
    drawElementHints:p.drawElementHints ?? [],
    drawNotes:       p.drawNotes ?? [],
    drawToolMode:    p.drawToolMode ?? "draw",
    apiHistory:      p.apiHistory ?? [],
    artifactPath:    p.artifactPath ?? null,
    variationPanelPosition: p.variationPanelPosition ?? null,
    generationState: "idle",  // always reset — never restore mid-stream
    activeMode: null,
    inputValue: "",
    reloadKey: 1,             // non-zero so iframe loads on restore
  }
}

function defaultSession() {
  return {
    chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }] as ChatTab[],
    activeTabId: SINGLE_DESIGN_TAB_ID,
    tabStates: { [SINGLE_DESIGN_TAB_ID]: makeTabState() } as Record<string, TabState>,
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
    tabStates: { [SINGLE_DESIGN_TAB_ID]: preferredState },
  }
}

// ── Per-session storage ───────────────────────────────────
const SESSION_INDEX_KEY  = "design_index_v1"
const SESSION_LAST_KEY   = "design_last_session"
const sessionDataKey     = (id: string) => `design_session_v2_${id}`

function parsePersistedSession(raw: string): ReturnType<typeof defaultSession> {
  const data: PersistedSession = JSON.parse(raw)
  if (!Array.isArray(data.chatTabs) || !data.chatTabs.length || !data.activeTabId) return defaultSession()
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
    tabStates: restoredStates,
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
      let result: { success: boolean; filePath?: string; html?: string; error?: string }
      if (state.artifactPath) {
        result = await window.api.design.readArtifactFile(state.artifactPath, workspacePath ?? undefined)
      } else {
        result = await window.api.design.readArtifact(artifactId, workspacePath ?? undefined)
      }
      if (!result.success || !result.html?.trim()) return [tabId, state] as const

      window.api.design.storeHtml(artifactId, result.html).catch(() => {})
      return [
        tabId,
        {
          ...hydrateTabStateHtml(state, result.html),
          artifactPath: result.filePath ?? state.artifactPath,
        },
      ] as const
    })
  )

  return {
    ...session,
    tabStates: Object.fromEntries(entries),
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
    window.parent.postMessage({type:'__iframe_scroll',x:window.scrollX,y:window.scrollY},'*');
  }
  window.addEventListener('scroll',report,{passive:true});
  report();
  window.__st_cleanup=function(){
    window.removeEventListener('scroll',report);
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
      if (/^#[0-9a-fA-F]{3,8}$/.test(v))   cssVars[key] = v
      else if (/^[\d.]+$/.test(v))           cssVars[key] = parseFloat(v)
      else if (/^(true|false)$/.test(v))     cssVars[key] = v === "true"
    }
  }
  if (Object.keys(cssVars).length > 0) return appendEditScript(html, cssVars)

  // 4. No CSS variables at all — extract hardcoded hex colors from <style> blocks,
  //    replace them with CSS var() references, and inject :root + EDITMODE script.
  return injectColorVars(html)
}

/** Append an EDITMODE script to html. vars keys are camelCase → CSS --kebab-case vars. */
function appendEditScript(html: string, vars: Record<string, unknown>): string {
  const setLines = Object.keys(vars).map((k) => {
    const cv = "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase()
    return `r.style.setProperty('${cv}',String(t['${k}']));`
  }).join("")
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
    .map((m) => m[1]).join("\n")
  const inlineContent = [...html.matchAll(/style="([^"]*)"/gi)]
    .map((m) => m[1]).join("\n")
  const allCssContent = styleContent + "\n" + inlineContent

  const freq: Map<string, number> = new Map()
  for (const [, h] of allCssContent.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const c = "#" + h.toLowerCase()
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }
  // Also try 3-digit hex from inline styles
  for (const [, h] of inlineContent.matchAll(/#([0-9a-fA-F]{3})\b/g)) {
    const c = "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]  // expand to 6-digit
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
  entries.forEach(({ key, hex }) => { vars[key] = hex })

  // Numeric tweaks extracted from CSS
  const fsMatch = styleContent.match(/\bfont-size\s*:\s*([\d.]+)px/)
  if (fsMatch) vars["fontSize"] = parseFloat(fsMatch[1])
  const rrMatch = styleContent.match(/\bborder-radius\s*:\s*([\d.]+)px/)
  if (rrMatch) vars["borderRadius"] = parseFloat(rrMatch[1])

  // Fallback: if no colors at all, use sensible generic defaults
  if (entries.length === 0) {
    vars["primaryColor"] = "#3b82f6"
    vars["fontSize"]     = vars["fontSize"] ?? 16
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
  const colorSet = entries.map(({ key, cssVar }) =>
    `r.style.setProperty('${cssVar}',String(t['${key}']));`
  ).join("")
  const numSet = [
    vars["fontSize"]     ? `r.style.setProperty('--font-size',t.fontSize+'px');`     : "",
    vars["borderRadius"] ? `r.style.setProperty('--border-radius',t.borderRadius+'px');` : "",
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
  return html.replace(
    /\/\*EDITMODE-BEGIN\*\/([\s\S]*?)\/\*EDITMODE-END\*\//,
    (_, existing) => {
      try {
        const current = JSON.parse(existing.trim()) as Record<string, unknown>
        const merged = { ...current, ...edits }
        return `/*EDITMODE-BEGIN*/${JSON.stringify(merged)}/*EDITMODE-END*/`
      } catch {
        return `/*EDITMODE-BEGIN*/${existing}/*EDITMODE-END*/`
      }
    }
  )
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
  } catch { /* cross-origin or not yet loaded */ }
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

  const [tabStates, setTabStates]     = useState<Record<string, TabState>>(_init.tabStates)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  // Code & link modal state
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [codeModalOpen, setCodeModalOpen] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkModalMode, setLinkModalMode] = useState<"reference" | "import">("reference")
  const [linkModalText, setLinkModalText] = useState("")
  const [importingSource, setImportingSource] = useState<null | "url" | "html">(null)
  // Toast notifications
  const [toast, setToast] = useState<{ msg: string; id: number } | null>(null)
  const showToast = useCallback((msg: string) => {
    const id = Date.now()
    setToast({ msg, id })
    setTimeout(() => setToast((t) => t?.id === id ? null : t), 3000)
  }, [])

  // Per-tab session tracking: tabId → { cleanup, sessionId }
  // Stored in a ref so it never triggers re-renders and isn't stale across tabs
  const tabSessionsRef = useRef<Map<string, { cleanup: () => void; sessionId: string }>>(new Map())

  // Canvas refs
  const iframeRef         = useRef<HTMLIFrameElement>(null)
  const canvasContainerRef = useRef<HTMLDivElement>(null)
  const activeTabId = SINGLE_DESIGN_TAB_ID
  const activeTabIdRef    = useRef(activeTabId)
  const tabStatesRef      = useRef(tabStates)
  const fileInputRef      = useRef<HTMLInputElement>(null)   // images only (screenshot / 📷)
  const messageListRef    = useRef<HTMLDivElement>(null)
  const skillOptionRefs   = useRef<Array<HTMLDivElement | null>>([])

  const ts = tabStates[activeTabId] ?? makeTabState()

  // ── Per-tab derived values (all read from ts) ────────────────
  const inputValue = ts.inputValue
  const tweaksOn   = ts.tweaksOn
  const activeMode = ts.activeMode
  const zoom       = ts.zoom

  const setInputValue = (val: string) => updateTs(activeTabId, { inputValue: val })
  const setTweaksOn   = (val: boolean | ((v: boolean) => boolean)) =>
    updateTs(activeTabId, (prev) => ({ tweaksOn: typeof val === "function" ? val(prev.tweaksOn) : val }))
  const setActiveMode = (val: "comment" | "edit" | "draw" | null) =>
    updateTs(activeTabId, (prev) => ({
      activeMode: val,
      draftDrawNote: val === "draw" ? prev.draftDrawNote : null,
    }))
  const setZoom = (val: number | ((v: number) => number)) =>
    updateTs(activeTabId, (prev) => ({ zoom: typeof val === "function" ? val(prev.zoom) : val }))

  // ── helpers ──────────────────────────────────────────────

  const updateTs = useCallback((tabId: string, patch: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
    setTabStates((prev) => {
      const current = prev[tabId] ?? makeTabState()
      const updates = typeof patch === "function" ? patch(current) : patch
      return { ...prev, [tabId]: { ...current, ...updates } }
    })
  }, [])

  // ── Fetch available model configs on mount ────────────────
  useEffect(() => {
    window.api.models.getCustomConfigs().then((configs) => {
      setAvailableModels(configs.map((c) => ({ id: c.id, name: c.name, model: c.model })))
    }).catch(() => {})
  }, [])

  // ── Fetch available skills on mount ───────────────────────
  useEffect(() => {
    window.api.skills.list().then((skills) => {
      setAllSkills(skills.map((s) => ({ name: s.name, description: s.description, path: s.path })))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.workspace.get().then((path) => {
      if (!cancelled) setWorkspacePath(path)
    }).catch(() => {
      if (!cancelled) setWorkspacePath(null)
    })
    return () => { cancelled = true }
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
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])
  useEffect(() => { tabStatesRef.current = tabStates }, [tabStates])
  useEffect(() => {
    const messageList = messageListRef.current
    if (!messageList) return
    window.requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight
    })
  }, [ts.messages, ts.generationState])
  // currentSessionId ref — needed inside startGeneration (which is a stable useCallback)
  // to produce a stable artifact ID without capturing a stale closure value.
  const currentSessionIdRef = useRef<string | null>(currentSessionId)
  useEffect(() => { currentSessionIdRef.current = currentSessionId }, [currentSessionId])
  useEffect(() => {
    if (!currentSessionId) return
    const session = normalizeSingleTabSession({
      chatTabs: [{ id: SINGLE_DESIGN_TAB_ID, label: SINGLE_DESIGN_TAB_LABEL }],
      activeTabId,
      tabStates,
    })
    hydrateSessionArtifacts(currentSessionId, session, workspacePath)
      .then((hydrated) => {
        if (currentSessionIdRef.current !== currentSessionId) return
        const hydratedState = hydrated.tabStates[SINGLE_DESIGN_TAB_ID]
        const currentState = tabStatesRef.current[SINGLE_DESIGN_TAB_ID]
        const snapshotState = session.tabStates[SINGLE_DESIGN_TAB_ID]
        if (!hydratedState || !currentState) return
        if (snapshotState && currentState.html !== snapshotState.html) return
        if (hydratedState.html === currentState.html) return
        setTabStates(hydrated.tabStates)
      })
      .catch(() => {})
    // Hydrate once per session/workspace; tabStates is only the initial snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId, workspacePath])

  const createSession = useCallback((metaPatch?: Partial<SessionMeta>): string => {
    const id = `ds_${uuid().slice(0, 8)}`
    const session = defaultSession()
    setTabStates(session.tabStates)
    setCurrentSessionId(id)
    localStorage.setItem(SESSION_LAST_KEY, id)
    const meta: SessionMeta = {
      id,
      title: metaPatch?.title ?? "新设计",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      kind: metaPatch?.kind ?? "prompt",
      sourceLabel: metaPatch?.sourceLabel,
    }
    setSessionIndex((prev) => {
      const next = [meta, ...prev]
      saveIndex(next)
      return next
    })
    return id
  }, [])

  const newSession = useCallback(() => {
    createSession()
  }, [createSession])

  const ensureWorkspaceSelected = useCallback(async (reason: string): Promise<boolean> => {
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
  }, [workspacePath, showToast])

  const readDependencyTextFile = useCallback(async (resolvedPath: string): Promise<string | null> => {
    const result = await window.api.file.readText(resolvedPath)
    return result.success ? (result.content ?? null) : null
  }, [])

  const syncContextFilesToWorkspace = useCallback(async (options: {
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
          sourcePath: file.filePath,
        })),
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
          content: file.content,
        })),
      })
      if (!synced.success) {
        throw new Error(synced.error || "同步代码上下文到工作目录失败")
      }
      result.codeDir = synced.dirPath
      result.codeFiles = synced.files
    }

    return result
  }, [workspacePath])

  const applyImportedDesign = useCallback((options: {
    sessionId: string
    html: string
    sourceInfo: DesignSourceInfo
    userMessage: string
  }) => {
    const tabId = SINGLE_DESIGN_TAB_ID
    const storeKey = makeDesignArtifactId(options.sessionId, tabId)
    const importedHtml = ensureEditMode(options.html)
    const variations = parseVariations(importedHtml)

    window.api.design.storeHtml(storeKey, importedHtml).catch(() => {})
    saveDesignArtifactForTab(
      storeKey,
      importedHtml,
      workspacePath,
      tabId,
      updateTs
    )

    updateTs(tabId, (prev) => ({
      messages: [
        { role: "user" as const, content: options.userMessage },
        { role: "assistant" as const, content: "✓ 页面已还原，可直接用 Tweaks 编辑，后续追问会基于当前 HTML 继续迭代。" },
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
      codeContext: null,
      designLink: null,
      attachedFiles: null,
      retryPrompt: null,
      retryIsIteration: false,
      retryCleanMsg: null,
      retrySkill: null,
      artifactPath: null,
      apiHistory: [
        { role: "user" as const, content: options.userMessage },
        { role: "assistant" as const, content: "页面已还原，可继续编辑" },
      ],
      pendingApproval: null,
    }))

    updateIndexMeta(options.sessionId, {
      title: options.sourceInfo.label,
      kind: options.sourceInfo.kind,
      sourceLabel: options.sourceInfo.label,
      updatedAt: Date.now(),
    })
    setSessionIndex(loadIndex())
  }, [workspacePath, updateTs])

  const loadImportedHtmlFromFile = useCallback(async (filePath: string): Promise<{
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
    })
    const htmlWithBase = injectBaseHref(inlinedHtml, makeFileHref(filePath))

    return {
      html: htmlWithBase,
      label: readResult.filename || getPathName(filePath) || "HTML 页面",
      detail: filePath,
    }
  }, [readDependencyTextFile])

  const loadImportedHtmlFromUrl = useCallback(async (url: string): Promise<{
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
      detail: displayUrl,
    }
  }, [])

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

  const handleImportHtmlFile = useCallback(async (source: "gallery" | "session") => {
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
      const sessionId = source === "gallery"
        ? createSession({
            title: imported.label,
            kind: "import_html",
            sourceLabel: imported.label,
          })
        : (currentSessionId ?? createSession({
            title: imported.label,
            kind: "import_html",
            sourceLabel: imported.label,
          }))

      applyImportedDesign({
        sessionId,
        html: imported.html,
        sourceInfo: { kind: "import_html", label: imported.label, detail: imported.detail },
        userMessage: `导入 HTML 文件：${imported.label}`,
      })
      setCreateModalOpen(false)
    } catch (err) {
      showToast(err instanceof Error ? err.message : "导入 HTML 页面失败")
    } finally {
      setImportingSource(null)
    }
  }, [ensureWorkspaceSelected, showToast, loadImportedHtmlFromFile, createSession, currentSessionId, applyImportedDesign])

  const handleImportUrl = useCallback(async (rawUrl: string, source: "gallery" | "session") => {
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
      const sessionId = source === "gallery"
        ? createSession({
            title: imported.label,
            kind: "import_url",
            sourceLabel: imported.label,
          })
        : (currentSessionId ?? createSession({
            title: imported.label,
            kind: "import_url",
            sourceLabel: imported.label,
          }))

      applyImportedDesign({
        sessionId,
        html: imported.html,
        sourceInfo: { kind: "import_url", label: imported.label, detail: imported.detail },
        userMessage: `通过链接还原页面：${imported.detail}`,
      })
      setCreateModalOpen(false)
      return true
    } catch (err) {
      showToast(err instanceof Error ? err.message : "导入链接页面失败")
      return false
    } finally {
      setImportingSource(null)
    }
  }, [ensureWorkspaceSelected, showToast, loadImportedHtmlFromUrl, createSession, currentSessionId, applyImportedDesign])

  // ── Persist session to localStorage (debounced 1.5s, skip during streaming) ──
  const _persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!currentSessionId) return  // don't save while in gallery
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
          ),
        }
        localStorage.setItem(sessionDataKey(currentSessionId), JSON.stringify(payload))
        // Update index metadata (title from first message, updatedAt)
        const firstState = tabStates[SINGLE_DESIGN_TAB_ID]
        const firstUserMsg = firstState?.messages?.find((m) => m.role === "user")
        const autoTitle = firstState?.sourceInfo?.label
          || (firstUserMsg ? (firstUserMsg.content as string).slice(0, 24) : "新设计")
        updateIndexMeta(currentSessionId, {
          updatedAt: Date.now(),
          title: autoTitle,
          kind: firstState?.sourceInfo?.kind ?? "prompt",
          sourceLabel: firstState?.sourceInfo?.label,
        })
        setSessionIndex(loadIndex())
      } catch {
        // Ignore persistence errors and keep the current in-memory session.
      }
    }, 1500)
    return () => { if (_persistTimerRef.current) clearTimeout(_persistTimerRef.current) }
  }, [activeTabId, tabStates, currentSessionId])

  // ── Session navigation ─────────────────────────────────────
  const openSession = useCallback((id: string) => {
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
        if (snapshotState && currentState?.html !== snapshotState.html) return
        setTabStates(hydrated.tabStates)
      })
      .catch(() => {})
  }, [workspacePath])

  const backToGallery = useCallback(() => {
    setCurrentSessionId(null)
    currentSessionIdRef.current = null
    localStorage.removeItem(SESSION_LAST_KEY)
    setSessionIndex(loadIndex())
  }, [])

  const deleteSession = useCallback((id: string) => {
    localStorage.removeItem(sessionDataKey(id))
    setSessionIndex((prev) => {
      const next = prev.filter((m) => m.id !== id)
      saveIndex(next)
      return next
    })
  }, [])

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
  }, [activeMode])

  // ── Listen for all postMessages from iframe ───────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data
      if (!msg?.type) return

      // ── Iframe scroll position update ─────────────────────
      if (msg.type === "__iframe_scroll") {
        const { x, y } = msg as { x: number; y: number }
        updateTs(activeTabIdRef.current, { iframeScrollX: x, iframeScrollY: y })
        return
      }

      // ── Comment click ──────────────────────────────────────
      if (msg.type === "__comment_click") {
        const { pageX, pageY, elementDesc } = msg as {
          pageX: number; pageY: number; elementDesc: string
        }
        updateTs(activeTabIdRef.current, {
          draftComment: { pageX, pageY, elementDesc: elementDesc || "元素" },
          activeCommentId: null,
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
            Promise.resolve().then(() => sendToIframe(iframeRef.current, { type: "__activate_edit_mode" }))
          }
          return prev  // no state change needed
        })
        return
      }

      // ── Edit select: user clicked an element in the iframe ───
      if (msg.type === "__edit_click") {
        const { edId, tagName, styles } = msg as { edId: string; tagName: string; styles: ElementStyles }
        updateTs(activeTabIdRef.current, { selectedElement: { edId, tagName, styles } })
        return
      }

      // ── Edit select: iframe sent its current outerHTML for saving ─
      if (msg.type === "__edit_html") {
        const { html } = msg as { html: string }
        const tabId = activeTabIdRef.current
        const state = tabStatesRef.current[tabId]
        const patchedHtml = ensureEditMode(html)
        saveDesignArtifactForTab(
          makeDesignArtifactId(currentSessionIdRef.current, tabId),
          patchedHtml,
          workspacePath,
          tabId,
          updateTs,
          state?.artifactPath ?? null
        )
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
                ),
              },
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
        saveDesignArtifactForTab(
          makeDesignArtifactId(currentSessionIdRef.current, tabId),
          updated,
          workspacePath,
          tabId,
          updateTs,
          state.artifactPath
        )
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
                ),
              },
            }
          }
          return { ...prev, [tabId]: { ...latest, html: updated } }
        })
        return
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [updateTs])

  // ── Ask Questions ─────────────────────────────────────────

  const startAskQuestions = useCallback((prompt: string, tabId: string, modelId?: string) => {
    const sessionId = uuid()
    updateTs(tabId, { generationState: "asking", originalPrompt: prompt, rightTab: "questions", questions: [] })

    // Cancel any existing session for this tab before starting a new one
    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    const cleanup = window.api.design.askQuestions(sessionId, prompt, (event) => {
      if (event.type === "model_retry") {
        const retry = asDesignModelRetryState(event)
        if (!retry) return
        updateTs(tabId, (prev) => ({
          messages: [
            ...prev.messages,
            { role: "assistant" as const, content: "", isStreaming: true, modelRetry: retry },
          ],
        }))
        return
      }

      if (event.type === "model_retry_clear") {
        updateTs(tabId, (prev) => ({
          messages: patchLastAssistantMessage(prev.messages, { modelRetry: null }),
        }))
        return
      }

      if (event.type === "done") {
        const qs = Array.isArray(event.questions) ? (event.questions as QuestionDef[]) : []
        updateTs(tabId, (prev) => ({
          generationState: "questions_ready",
          questions: qs,
          rightTab: "questions",   // re-assert — guards against any interleaved update
          messages: [
            ...prev.messages.filter((msg) => !(msg.role === "assistant" && msg.isStreaming && msg.modelRetry)),
            { role: "questions-prompt" as const, content: "请补充相关问题 →" },
          ],
        }))
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => ({
          generationState: "error",
          messages: [
            ...prev.messages.filter((msg) => !(msg.role === "assistant" && msg.isStreaming && msg.modelRetry)),
            { role: "assistant" as const, content: `❌ ${event.error ?? "Failed to generate questions"}` },
          ],
        }))
        tabSessionsRef.current.delete(tabId)
      }
    }, modelId)
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [updateTs])

  // ── Generate Design ───────────────────────────────────────

  const startGeneration = useCallback((
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
          executionEvents: [],
        },
      ],
    }))

    // Cancel any existing session for this tab before starting a new one
    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    // Route through the full Agent Runtime: Skills, MCP tools, Hooks, Approvals,
    // context summarisation. Each design session gets an isolated thread.
    const designSessionId = currentSessionIdRef.current
    const agentRuntimeSessionId = freshAgentThread
      ? `retry_${sessionId}_${designSessionId ?? "session"}`
      : designSessionId
    const agentThreadId = makeDesignAgentThreadId(agentRuntimeSessionId, tabId)
    const cleanupApprovalRequest = window.api.sandbox.onApprovalRequest(agentThreadId, (request) => {
      updateTs(tabId, { pendingApproval: asDesignApprovalRequest(request) })
    })
    const cleanupApprovalTimeout = window.api.sandbox.onApprovalTimeout(agentThreadId, (data) => {
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
      updateTs(tabId, { pendingApproval: null })
    }

    // Stable artifact ID: based on the design session + tab, NOT the streaming session UUID.
    // Using the streaming sessionId (which changes per-call) would create a new artifact
    // directory every generation, making the filesystem-based context chain useless.
    const stableArtifactId = makeDesignArtifactId(currentSessionIdRef.current, tabId)

    const onEvent = (event: {
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
    }) => {
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
            executionEvents: appendDesignExecutionEvent(msgs[last].executionEvents ?? [], executionEvent),
          }
          return { messages: msgs }
        })
        return
      }

      if (event.type === "done" && event.html) {
        // Guarantee every generated design has a working EDITMODE block
        const patchedHtml = ensureEditMode(event.html)
        const variations = parseVariations(patchedHtml)

        // Keep htmlStore in sync (used as fallback / reference)
        window.api.design.storeHtml(stableArtifactId, patchedHtml).catch(() => {})
        if (event.artifactPath) {
          updateTs(tabId, { artifactPath: event.artifactPath })
        } else {
          saveDesignArtifactForTab(stableArtifactId, patchedHtml, workspacePath, tabId, updateTs)
        }

        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          const doneLabel = variations.length > 0
            ? `✓ ${isIteration ? "Design updated" : "Design generated"} — ${variations.length} variations`
            : isIteration ? "✓ Design updated" : "✓ Design generated"
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: doneLabel, isStreaming: false, modelRetry: null }
          }

          // Keep apiHistory in sync for display / session backup
          const prevHistory = prev.apiHistory ?? []
          const newHistory: Array<{ role: "user" | "assistant"; content: string }> = cleanUserMsg
            ? [
                ...prevHistory,
                { role: "user" as const, content: cleanUserMsg },
                { role: "assistant" as const, content: doneLabel },
              ]
            : prevHistory

          return {
            generationState: "done",
            html: patchedHtml,
            messages: msgs,
            variations,
            activeVariationId: variations[0]?.id ?? null,
            apiHistory: newHistory,
          }
        })

        if (variations.length > 0) {
          variations.forEach((v) => { window.api.design.saveVariant(v.id, v.html).catch(() => {}) })
        }
        cleanup()
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false, modelRetry: null }
          }
          return { generationState: "error", messages: msgs }
        })
        cleanup()
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false, modelRetry: null }
          return { generationState: "idle", messages: msgs }
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
      isIteration ? getCurrentDesignHtml(tabStates[tabId]) : undefined,
      skill ?? undefined,
      workspacePath ?? undefined,
      stableArtifactId,
      sourceArtifactPath ?? undefined,
      agentRuntimeSessionId ?? undefined
    )
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [tabStates, updateTs, workspacePath])

  // ── Generate Design from Screenshot ──────────────────────

  const startGenerationFromImage = useCallback((
    prompt: string, imageBase64: string, mimeType: string, tabId: string, modelId?: string
  ) => {
    const sessionId = uuid()
    console.log(`[Design:Image] startGenerationFromImage — sessionId=${sessionId} mimeType=${mimeType} base64Len=${imageBase64.length} prompt="${prompt.slice(0, 80)}"`)
    updateTs(tabId, (prev) => ({
      generationState: "generating",
      rightTab: "design",
      attachedImage: null,  // clear preview once generation starts
      messages: [
        ...prev.messages,
        { role: "assistant" as const, content: "", isStreaming: true, isIteration: false },
      ],
    }))

    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    console.log("[Design:Image] Calling window.api.design.generateFromImage…")
    const cleanup = window.api.design.generateFromImage(sessionId, prompt, imageBase64, mimeType, (event) => {
      console.log(`[Design:Image] Renderer received event: type=${event.type}${event.error ? " error=" + event.error : ""}`)
      if (event.type === "model_retry") {
        const retry = asDesignModelRetryState(event)
        if (!retry) return
        updateTs(tabId, (prev) => ({
          messages: patchLastAssistantMessage(prev.messages, { modelRetry: retry }),
        }))
        return
      }

      if (event.type === "model_retry_clear") {
        updateTs(tabId, (prev) => ({
          messages: patchLastAssistantMessage(prev.messages, { modelRetry: null }),
        }))
        return
      }

      if (event.type === "done" && event.html) {
        const patchedHtml = ensureEditMode(event.html)
        // Store full HTML in main process so subsequent text iterations can reference it
        const storeKey = makeDesignArtifactId(currentSessionIdRef.current, tabId)
        window.api.design.storeHtml(storeKey, patchedHtml).catch(() => {})
        saveDesignArtifactForTab(storeKey, patchedHtml, workspacePath, tabId, updateTs)
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: "✓ 设计已生成", isStreaming: false, modelRetry: null }
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
              { role: "assistant" as const, content: "✓ 设计已生成" },
            ],
          }
        })
        window.api.design.saveVariant("image", patchedHtml).catch(() => {})
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false, modelRetry: null }
          }
          return { generationState: "error", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false, modelRetry: null }
          return { generationState: "idle", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      }
    }, modelId)
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [currentSessionId, updateTs, workspacePath])

  // ── Handle file input selection (screenshot upload) ───────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    console.log(`[Design:Image] File selected — name="${file.name}" size=${file.size} type="${file.type}"`)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const dataUrl = ev.target?.result as string
      const comma = dataUrl.indexOf(",")
      const header = dataUrl.slice(0, comma)
      const base64 = dataUrl.slice(comma + 1)
      const mimeType = header.match(/data:([^;]+)/)?.[1] ?? "image/png"
      console.log(`[Design:Image] File read as base64 — mimeType="${mimeType}" base64Len=${base64.length}`)
      updateTs(activeTabId, { attachedImage: { base64, mimeType, previewUrl: dataUrl } })
    }
    reader.onerror = (err) => {
      console.error("[Design:Image] FileReader error:", err)
    }
    reader.readAsDataURL(file)
    // Reset so the same file can be re-selected
    e.target.value = ""
  }, [activeTabId, updateTs])

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
                attachedFiles: [...(prev.attachedFiles ?? []), res.attachment!],
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
    )
  }, [activeTabId, tabStates, updateTs, startGeneration])

  // ── Build comment prompt helper ───────────────────────────
  // Returns both the instruction prompt (no HTML — main process injects via htmlStore)
  // and the current HTML so the caller can push it to the store.
  const buildCommentPrompt = useCallback((
    comments: { elementDesc: string; text: string }[],
    state: TabState
  ): { prompt: string } => {
    const activeVarId = state.activeVariationId
    const variantNote = activeVarId ? `\n[正在迭代变体 ${activeVarId.toUpperCase()}。]` : ""
    const commentLines = comments
      .map((c, i) => `[${i + 1}] 元素 (${c.elementDesc}): ${c.text}`)
      .join("\n")

    const prompt = `用户通过 Comment 模式在设计上标注了以下修改意见。请严格按照每条批注对对应元素进行修改，其他部分完全保持不变：

${commentLines}${variantNote}`

    return { prompt }
  }, [])

  // ── Send a single comment directly (without saving to list) ─
  const handleSendDraftComment = useCallback((text: string, elementDesc: string) => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state || !text.trim()) return

    const { prompt } = buildCommentPrompt([{ elementDesc, text }], state)
    const cleanMsg = `📝 ${text.trim().slice(0, 60)}`

    updateTs(tabId, (prev) => ({
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: cleanMsg },
      ],
    }))
    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg, undefined, undefined, state.artifactPath)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Send a saved comment pin → model ─────────────────────
  const handleSendComment = useCallback((commentId: string, overrideText?: string) => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    if (!state) return

    const comment = state.comments.find((c) => c.id === commentId)
    if (!comment) return

    const text = overrideText ?? comment.text
    const { prompt } = buildCommentPrompt([{ elementDesc: comment.elementDesc, text }], state)
    const cleanMsg = `📝 ${text.trim().slice(0, 60)}`

    updateTs(tabId, (prev) => ({
      comments: prev.comments.filter((c) => c.id !== commentId),
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: cleanMsg },
      ],
    }))
    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg, undefined, undefined, state.artifactPath)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Edit a saved comment's text ───────────────────────────
  const handleEditComment = useCallback((commentId: string, newText: string) => {
    updateTs(activeTabId, (prev) => ({
      comments: prev.comments.map((c) =>
        c.id === commentId ? { ...c, text: newText } : c
      ),
    }))
  }, [activeTabId, updateTs])

  // ── Edit select: apply a style property to the selected element live ─
  const handleEditStyleChange = useCallback((property: string, value: unknown) => {
    sendToIframe(iframeRef.current, { type: "__edit_style", property, value })
    // Optimistic UI: update panel immediately without waiting for __edit_click echo
    updateTs(activeTabId, (prev) => {
      if (!prev.selectedElement) return {}
      return {
        selectedElement: {
          ...prev.selectedElement,
          styles: { ...prev.selectedElement.styles, [property]: value } as ElementStyles,
        },
      }
    })
  }, [activeTabId, updateTs])

  // ── Apply ALL saved comments → send to model ─────────────
  const handleApplyComments = useCallback(() => {
    const tabId = activeTabId
    const state = tabStates[tabId]
    const pending = state?.comments ?? []
    if (pending.length === 0) return

    const { prompt } = buildCommentPrompt(
      pending.map((c) => ({ elementDesc: c.elementDesc, text: c.text })),
      state
    )
    const cleanMsg = `📝 发送 ${pending.length} 条批注`

    updateTs(tabId, (prev) => ({
      comments: [],
      draftComment: null,
      activeCommentId: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: cleanMsg },
      ],
    }))

    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg, undefined, undefined, state.artifactPath)
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

  const collectDrawElementHint = useCallback((stroke: DrawStroke): DrawElementHint => {
    return { strokeId: stroke.id, elements: collectDrawElementLabels(stroke.points) }
  }, [collectDrawElementLabels])

  const handleDrawNoteDraft = useCallback((point: DrawPoint) => {
    updateTs(activeTabId, {
      draftDrawNote: {
        pageX: point.x,
        pageY: point.y,
        elements: collectDrawElementLabels([point]),
      },
    })
  }, [activeTabId, updateTs, collectDrawElementLabels])

  const handleDrawNoteSubmit = useCallback((text: string) => {
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
        text: value,
        elements: prev.draftDrawNote.elements,
        createdAt: Date.now(),
      }
      return {
        drawNotes: [...prev.drawNotes, note],
        draftDrawNote: null,
      }
    })
  }, [activeTabId, updateTs])

  const handleDrawNoteCancel = useCallback(() => {
    updateTs(activeTabId, { draftDrawNote: null })
  }, [activeTabId, updateTs])

  const handleDrawToolModeChange = useCallback((mode: DrawToolMode) => {
    updateTs(activeTabId, { drawToolMode: mode, draftDrawNote: null })
  }, [activeTabId, updateTs])

  const handleDrawStrokeComplete = useCallback((stroke: DrawStroke) => {
    const hint = collectDrawElementHint(stroke)
    updateTs(activeTabId, (prev) => ({
      drawStrokes: [...prev.drawStrokes, stroke],
      drawElementHints: [
        ...prev.drawElementHints.filter((item) => item.strokeId !== stroke.id),
        hint,
      ],
    }))
  }, [activeTabId, updateTs, collectDrawElementHint])

  const handleUndoDrawStroke = useCallback(() => {
    updateTs(activeTabId, (prev) => {
      const removedStroke = prev.drawStrokes[prev.drawStrokes.length - 1]
      const removedNote = prev.drawNotes[prev.drawNotes.length - 1]
      if (removedNote && (!removedStroke || removedNote.createdAt > removedStroke.createdAt)) {
        return {
          drawNotes: prev.drawNotes.slice(0, -1),
          draftDrawNote: null,
        }
      }
      return {
        drawStrokes: prev.drawStrokes.slice(0, -1),
        drawElementHints: removedStroke
          ? prev.drawElementHints.filter((hint) => hint.strokeId !== removedStroke.id)
          : prev.drawElementHints,
        draftDrawNote: null,
      }
    })
  }, [activeTabId, updateTs])

  const handleClearDrawStrokes = useCallback(() => {
    updateTs(activeTabId, { drawStrokes: [], drawElementHints: [], drawNotes: [], draftDrawNote: null })
  }, [activeTabId, updateTs])

  const handleDrawWheel = useCallback((deltaX: number, deltaY: number) => {
    const scale = Math.max((tabStatesRef.current[activeTabIdRef.current]?.zoom ?? 100) / 100, 0.25)
    iframeRef.current?.contentWindow?.scrollBy({
      left: deltaX / scale,
      top: deltaY / scale,
      behavior: "auto",
    })
  }, [])

  const buildDrawPrompt = useCallback((state: TabState, userInstruction = ""): { prompt: string } => {
    const activeVarId = state.activeVariationId
    const variantNote = activeVarId ? `\n[正在迭代变体 ${activeVarId.toUpperCase()}。]` : ""
    const hintsByStroke = new Map(state.drawElementHints.map((hint) => [hint.strokeId, hint.elements]))
    const instruction = userInstruction.trim()
    const instructionLine = instruction
      ? `\n用户补充说明：${instruction}\n`
      : "\n用户没有补充文字时，请优先遵循黄色 note 的文本，并把红色绘制区域理解为需要重点优化或修正的 UI 区域。\n"
    const strokeLines = state.drawStrokes.filter((stroke) => stroke.points.length > 0).map((stroke, index) => {
      const xs = stroke.points.map((point) => point.x)
      const ys = stroke.points.map((point) => point.y)
      const minX = Math.round(Math.min(...xs))
      const maxX = Math.round(Math.max(...xs))
      const minY = Math.round(Math.min(...ys))
      const maxY = Math.round(Math.max(...ys))
      const elements = hintsByStroke.get(stroke.id)?.filter(Boolean) ?? []
      const elementText = elements.length > 0 ? `；覆盖/接近元素：${elements.join(", ")}` : ""
      return `[${index + 1}] ${stroke.color} 画笔，粗细 ${stroke.width}px，区域 x:${minX}-${maxX}, y:${minY}-${maxY}，${stroke.points.length} 个点${elementText}`
    }).join("\n")
    const noteLines = state.drawNotes.map((note, index) => {
      const elementText = note.elements.length > 0 ? `；接近元素：${note.elements.join(", ")}` : ""
      return `[${index + 1}] note 坐标 x:${Math.round(note.pageX)}, y:${Math.round(note.pageY)}${elementText}\n内容：${note.text}`
    }).join("\n")

    const prompt = `用户通过 Draw 模式直接在设计预览上做了标记。请把红色画线理解为视觉指向和编辑意图：线条圈出的、划过的或指向的区域是需要重点调整的区域。黄色 note 是用户在页面任意位置添加的明确文本指令，优先按 note 内容执行。不要把画线或 note 本身渲染进最终页面。请根据标记位置对当前设计做有针对性的视觉优化，保持未标记区域尽量不变。
${instructionLine}

红色绘制标记：
${strokeLines || "无"}

黄色 note：
${noteLines || "无"}${variantNote}`

    return { prompt }
  }, [])

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

    updateTs(tabId, (prev) => ({
      inputValue: "",
      drawStrokes: [],
      drawElementHints: [],
      drawNotes: [],
      draftDrawNote: null,
      messages: [
        ...prev.messages,
        { role: "user" as const, content: cleanMsg },
      ],
    }))

    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg, undefined, undefined, state.artifactPath)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildDrawPrompt])

  // ── Send message ──────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const prompt = (tabStates[activeTabId]?.inputValue ?? "").trim()
    const attachedImage = tabStates[activeTabId]?.attachedImage ?? null
    const selectedModelId = tabStates[activeTabId]?.selectedModelId ?? undefined
    const selectedSkill = tabStates[activeTabId]?.selectedSkill ?? null
    const codeContext    = tabStates[activeTabId]?.codeContext ?? null
    const designLink     = tabStates[activeTabId]?.designLink ?? null
    const attachedFiles  = tabStates[activeTabId]?.attachedFiles ?? null
    if (!prompt && !attachedImage) return
    const state = tabStates[activeTabId]?.generationState ?? "idle"
    if (state === "asking" || state === "generating") return

    const workspaceRequirementReason = getWorkspaceRequirementReason({
      selectedSkill,
      codeContext,
      prompt,
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
      ...(codeContext ?? []).map((f): MessageAttachment => ({
        filename: f.filename,
        kind: "code",
        meta: `${f.content.split("\n").length.toLocaleString()} 行`,
      })),
      ...(attachedFiles ?? []).map((f): MessageAttachment => ({
        filename: f.filename,
        kind: "doc",
        meta: `${f.content.length.toLocaleString()} 字符`,
      })),
    ]

    // Clear transient context after send — skill, files, and code all clear per-send
    updateTs(activeTabId, { inputValue: "", selectedSkill: null, attachedFiles: null, codeContext: null })

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
      `Apply the skill's design tokens and patterns inside that HTML file.`
    const skillContext = selectedSkill ? `\n\n---\n${designOutputConstraint}` : ""
    const inlineCodeSuffix = codeContext && codeContext.length > 0
      ? "\n\n---\n[Code context — " + codeContext.length + " file(s)]\n" +
        codeContext.map((f) => {
          const ext = f.filename.split(".").pop() ?? ""
          return "```" + ext + "\n// " + f.filename + "\n" + f.content.slice(0, 2000) + "\n```"
        }).join("\n\n")
      : ""
    const linkSuffix = designLink
      ? `\n\n---\n[Design reference URL: ${designLink}]\nPlease use this as a visual/layout reference for the design.`
      : ""
    const workspaceFilesSuffix = (() => {
      const lines: string[] = []
      if (syncedContext.attachmentsDir) {
        lines.push(`[Workspace attachment directory]\n${syncedContext.attachmentsDir}`)
        if (syncedContext.attachmentFiles && syncedContext.attachmentFiles.length > 0) {
          lines.push(...syncedContext.attachmentFiles.map((file) => `- ${file.filename}: ${file.targetPath}`))
        }
      }
      if (syncedContext.codeDir) {
        lines.push(`[Workspace code-context directory]\n${syncedContext.codeDir}`)
        if (syncedContext.codeFiles && syncedContext.codeFiles.length > 0) {
          lines.push(...syncedContext.codeFiles.map((file) => `- ${file.filename}: ${file.targetPath}`))
        }
      }
      if (lines.length === 0) return ""
      return "\n\n---\n[Workspace-synced context files]\n" +
        "These files were copied into the current design workspace before this request. " +
        "If you need to inspect or search the uploaded files, use these workspace paths instead of assuming the originals are present.\n" +
        lines.join("\n")
    })()
    const workspaceFileSummarySuffix = selectedSkill
      ? (() => {
          const lines: string[] = []
          if (codeContext && codeContext.length > 0) {
            lines.push(`[Code context summary — ${codeContext.length} file(s)]`)
            lines.push(...codeContext.map((file) => `- ${getPathName(file.filename) || file.filename}`))
          }
          if (attachedFiles && attachedFiles.length > 0) {
            lines.push(`[Attached file summary — ${attachedFiles.length} file(s)]`)
            lines.push(...attachedFiles.map((file) => `- ${file.filename}${file.truncated ? " (truncated preview available in UI)" : ""}`))
          }
          if (lines.length === 0) return ""
          return "\n\n---\n[Context file summary]\n" +
            "These files are available in the synced workspace paths above. Prefer reading/searching those files from the workspace instead of relying on inline prompt copies.\n" +
            lines.join("\n")
        })()
      : ""
    const inlineFilesSuffix = attachedFiles && attachedFiles.length > 0
      ? "\n\n---\n[Attached files — " + attachedFiles.length + " file(s)]\n" +
        attachedFiles.map((f) =>
          `### ${f.filename}${f.truncated ? " (truncated)" : ""}\n${f.content}`
        ).join("\n\n")
      : ""
    const contextSuffix = skillContext
      + linkSuffix
      + workspaceFilesSuffix
      + workspaceFileSummarySuffix
      + (selectedSkill ? "" : inlineCodeSuffix)
      + (selectedSkill ? "" : inlineFilesSuffix)
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
            role: "user" as const, content: userContent,
            skillName: selectedSkill?.name,
            attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
            imageUrl: attachedImage.previewUrl,
          },
        ],
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
        startGenerationFromImage(prompt + contextSuffix, attachedImage.base64, attachedImage.mimeType, tabId, selectedModelId)
      }
      return
    }

    // Always add user message first (skill shown as pill, not embedded in text)
    updateTs(tabId, (prev) => ({
      messages: [
        ...prev.messages,
        {
          role: "user" as const, content: prompt,
          skillName: selectedSkill?.name,
          attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
        },
      ],
    }))

    // New design requests should use the clarifying-question flow unless a skill
    // is explicitly selected. Chat history alone is not enough to count as an
    // iteration because failed or question-only runs may leave messages without HTML.
    if (!hasExistingDesign) {
      if (selectedSkill) {
        startGeneration(prompt + contextSuffix, tabId, false, selectedModelId, prompt, undefined, skillReference)
      } else {
        startAskQuestions(prompt + contextSuffix, tabId, selectedModelId)
      }
    } else {
      // Subsequent messages → iterate on existing design
      const currentState = tabStates[tabId]
      const activeVarId  = currentState?.activeVariationId ?? null
      const contextHtml  = activeVarId
        ? (currentState?.variations.find((v) => v.id === activeVarId)?.html ?? currentState?.html ?? "")
        : (currentState?.html ?? "")

      // ── Multi-turn iteration ──────────────────────────────
      // LangGraph checkpointing (threadId = tabId) automatically provides full
      // conversation history to the model — no need to embed HTML or pass history manually.
      const variantNote = activeVarId
        ? `\n[Iterating on Variation ${activeVarId.toUpperCase()} specifically.]`
        : ""

      const iterationPrompt = `User follow-up instruction: ${prompt}${variantNote}`
      const artifactPath = currentState?.artifactPath

      startGeneration(
        iterationPrompt + contextSuffix,
        tabId,
        /* isIteration */ !!contextHtml,
        selectedModelId,
        prompt,   // clean user message for apiHistory recording
        undefined,
        skillReference,
        artifactPath ?? null
      )
    }
  }, [activeTabId, tabStates, updateTs, startAskQuestions, startGeneration, startGenerationFromImage, workspacePath, showToast, syncContextFilesToWorkspace])

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
      ? `${originalPrompt}\n\n---\nUser's answers to clarifying questions:\n${answerLines}\n\nRemember: Generate exactly 2 variations (A / B) within one HTML file.`
      : `${originalPrompt}\n\n---\nNo clarifying answers were provided. Generate exactly 2 variations (A / B) within one HTML file.`

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
      messages: prev.messages.map((m, i) =>
        i === 0 && m.role === "user" ? { ...m, tags } : m
      ),
      answers,
    }))

    // Pass originalPrompt as cleanUserMsg so it's recorded in apiHistory after generation
    startGeneration(enrichedPrompt, tabId, false, state.selectedModelId ?? undefined, originalPrompt)
  }, [activeTabId, tabStates, updateTs, startGeneration])

  const handleCancel = useCallback(() => {
    const entry = tabSessionsRef.current.get(activeTabId)
    if (entry) {
      entry.cleanup()
      window.api.design.cancel(entry.sessionId).catch(() => {})
      tabSessionsRef.current.delete(activeTabId)
    }
    updateTs(activeTabId, { generationState: "idle", pendingApproval: null })
  }, [activeTabId, updateTs])

  const handleDesignApprovalDecision = useCallback((decision: DesignApprovalDecision) => {
    const pendingApproval = tabStates[activeTabId]?.pendingApproval
    if (!pendingApproval) return

    if (pendingApproval._orchestratorRequestId) {
      window.api.sandbox.sendApprovalDecision({
        requestId: pendingApproval._orchestratorRequestId,
        type: decision,
        tool_call_id: pendingApproval.tool_call?.id || "",
      })
    }

    updateTs(activeTabId, { pendingApproval: null })
  }, [activeTabId, tabStates, updateTs])

  // ── Slash-command skill picker ────────────────────────────
  // Triggered when the input value is just "/" optionally followed by a filter word
  const slashMatch     = inputValue.match(/^\/(\S*)$/)
  const isSlashMode    = !!slashMatch
  const slashQuery     = (slashMatch?.[1] ?? "").toLowerCase()
  const filteredSkills = isSlashMode
    ? allSkills.filter((s) => !slashQuery || s.name.toLowerCase().includes(slashQuery))
    : []

  useEffect(() => {
    if (isSlashMode) setActiveSkillIndex(0)
  }, [isSlashMode, slashQuery])

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

  const handleSkillSelect = useCallback(async (skill: SkillInfo) => {
    setInputValue("")  // clear "/" from input
    // Optimistically set skill without content first
    updateTs(activeTabId, (prev) => ({ ...prev, selectedSkill: { ...skill } }))
    // Try to load the SKILL.md content
    try {
      const result = await window.api.skills.read(skill.path)
      if (result.success && result.content) {
        updateTs(activeTabId, (prev) => ({
          ...prev,
          selectedSkill: prev.selectedSkill?.name === skill.name
            ? { ...prev.selectedSkill, content: result.content }
            : prev.selectedSkill,
        }))
      }
    } catch { /* skill content optional */ }
  }, [activeTabId, updateTs, setInputValue])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSlashMode) {
      if (e.key === "Escape") { e.preventDefault(); setInputValue(""); return }
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
      return  // let other keys type the filter query
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const setAnswer = useCallback((qId: string, value: AnswerValue) => {
    updateTs(activeTabId, (prev) => ({ answers: { ...prev.answers, [qId]: value } }))
  }, [activeTabId, updateTs])

  const isGenerating = ts.generationState === "generating"
  const isAsking     = ts.generationState === "asking"
  const isBlocked    = isGenerating || isAsking || ts.generationState === "questions_ready"

  const handleLinkModalConfirm = useCallback(async () => {
    if (linkModalMode === "reference") {
      updateTs(activeTabId, { designLink: linkModalText.trim() })
      setLinkModalOpen(false)
      return
    }

    const imported = await handleImportUrl(linkModalText, currentSessionId === null ? "gallery" : "session")
    if (imported) {
      setLinkModalOpen(false)
      setLinkModalText("")
    }
  }, [linkModalMode, updateTs, activeTabId, linkModalText, handleImportUrl, currentSessionId])

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
          onSelectWorkspace={() => { void handleSelectWorkspace() }}
        />
        <CreateDesignModal
          open={createModalOpen}
          loadingKind={importingSource}
          workspacePath={workspacePath}
          workspaceLoading={workspaceLoading}
          onSelectWorkspace={() => { void handleSelectWorkspace() }}
          onCreateBlank={() => {
            createSession()
            setCreateModalOpen(false)
          }}
          onImportUrl={() => { void openImportUrlModal() }}
          onImportHtml={() => { void handleImportHtmlFile("gallery") }}
          onClose={() => setCreateModalOpen(false)}
        />
        <LinkModal
          open={linkModalOpen}
          mode={linkModalMode}
          url={linkModalText}
          loading={importingSource === "url"}
          onUrlChange={setLinkModalText}
          onConfirm={() => { void handleLinkModalConfirm() }}
          onClose={() => setLinkModalOpen(false)}
        />
        {toast && (
          <div style={{
            position: "fixed", bottom: 120, left: "50%", transform: "translateX(-50%)",
            background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 13, fontWeight: 500,
            padding: "9px 18px", borderRadius: 20, zIndex: 99999,
            pointerEvents: "none", whiteSpace: "nowrap",
            boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}>
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
        onSelectWorkspace={() => { void handleSelectWorkspace() }}
        onCreateBlank={() => {
          newSession()
          setCreateModalOpen(false)
        }}
        onImportUrl={() => { void openImportUrlModal() }}
        onImportHtml={() => { void handleImportHtmlFile("session") }}
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
        onConfirm={() => { void handleLinkModalConfirm() }}
        onClose={() => setLinkModalOpen(false)}
      />

      {/* Toast notification */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 120, left: "50%", transform: "translateX(-50%)",
          background: "rgba(30,30,30,0.92)", color: "#fff", fontSize: 13, fontWeight: 500,
          padding: "9px 18px", borderRadius: 20, zIndex: 99999,
          pointerEvents: "none", whiteSpace: "nowrap",
          boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
          border: "1px solid rgba(255,255,255,0.08)",
        }}>
          {toast.msg}
        </div>
      )}

      {/* Title Bar */}
      <div style={S.titleBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={backToGallery}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "4px 10px 4px 6px",
              background: "none", border: "1px solid #d4d2cc",
              borderRadius: 8, cursor: "pointer",
              fontSize: 12, fontWeight: 500, color: "#6a6a6a",
              fontFamily: "inherit", lineHeight: 1,
            }}
            title="返回历史记录"
          >
            ← 我的设计
          </button>
          <div style={S.logo}>✦</div>
          <span style={S.titleText}>design</span>
          {ts.sourceInfo && (
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "3px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              color: "#7a4300",
              background: "#fff2df",
              border: "1px solid #f0d3a6",
            }}>
              {getSessionKindLabel(ts.sourceInfo.kind)}
            </span>
          )}
        </div>
        <div style={S.titleActions}>
          <button
            onClick={handleSelectWorkspace}
            disabled={workspaceLoading || isGenerating}
            style={{
              ...S.workspaceBtn,
              opacity: workspaceLoading ? 0.65 : 1,
              cursor: workspaceLoading || isGenerating ? "default" : "pointer",
              color: workspacePath ? "#1a1a1a" : "#9a5b00",
              borderColor: workspacePath ? "#d4d2cc" : "#e7bf7a",
              background: workspacePath ? "#ffffff" : "#fff7e6",
            }}
            title={workspacePath ? `工作目录: ${workspacePath}（点击切换）` : "选择工作目录（用于保存设计产物）"}
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
                onImportHtml={() => { void handleImportHtmlFile("session") }}
              />
            ) : (
              <div ref={messageListRef} style={S.messageList}>
                {ts.messages.map((msg, i) => (
                  <MessageBubble key={i} message={msg} />
                ))}
                {isAsking && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", color: "#8a8a8a", fontSize: 13 }}>
                    <PulsingDot />
                    <span>Generating questions…</span>
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
              <div style={{
                position: "absolute", bottom: "calc(100% + 4px)", left: 12, right: 12,
                background: "#ffffff", border: "1px solid #e0ded8", borderRadius: 10,
                boxShadow: "0 4px 16px rgba(0,0,0,0.10)",
                maxHeight: 220, overflowY: "auto", zIndex: 200,
              }}>
                <div style={{ padding: "6px 8px 4px", fontSize: 11, color: "#a0a0a0", fontWeight: 500, borderBottom: "1px solid #f0eee8" }}>
                  ⚡ 技能 — ↑↓ 选择，↵ 确认，Esc 取消
                </div>
                {filteredSkills.map((skill, i) => {
                  const isActive = i === activeSkillIndex
                  return (
                    <div
                      key={skill.name}
                      ref={(node) => { skillOptionRefs.current[i] = node }}
                      onClick={() => handleSkillSelect(skill)}
                      onMouseEnter={() => setActiveSkillIndex(i)}
                      style={{
                        padding: "8px 12px", cursor: "pointer",
                        background: isActive ? "#f3f2ee" : "transparent",
                        borderBottom: i < filteredSkills.length - 1 ? "1px solid #f4f3f0" : "none",
                        transition: "background 0.1s",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14 }}>⚡</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a" }}>{skill.name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "#8a8a8a", marginTop: 2, marginLeft: 20, lineHeight: 1.4 }}>
                        {skill.description.slice(0, 80)}{skill.description.length > 80 ? "…" : ""}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {isSlashMode && filteredSkills.length === 0 && slashQuery && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 4px)", left: 12, right: 12,
                background: "#ffffff", border: "1px solid #e0ded8", borderRadius: 10,
                boxShadow: "0 4px 16px rgba(0,0,0,0.10)", padding: "10px 14px",
                fontSize: 12, color: "#a0a0a0", zIndex: 200,
              }}>
                无匹配技能 — 输入 / 不加文字可查看全部
              </div>
            )}
            <div style={S.inputBox}>
              {/* Screenshot preview strip */}
              {ts.attachedImage && (
                <div style={{ padding: "8px 12px 0", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ position: "relative", display: "inline-block" }}>
                    <img
                      src={ts.attachedImage.previewUrl}
                      style={{ height: 60, maxWidth: 120, borderRadius: 8, objectFit: "cover", border: "1px solid #e8e6e0", display: "block" }}
                      alt="截图预览"
                    />
                    <button
                      onClick={() => updateTs(activeTabId, { attachedImage: null })}
                      style={{
                        position: "absolute", top: -6, right: -6,
                        width: 18, height: 18, borderRadius: "50%",
                        background: "#1a1a1a", border: "none",
                        color: "#fff", fontSize: 11, cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        lineHeight: 1, fontFamily: "inherit",
                      }}
                    >×</button>
                  </div>
                  <span style={{ fontSize: 12, color: "#8a8a8a" }}>截图已附加</span>
                </div>
              )}
              {/* Context pills row — skill / code / design-link / attached files */}
              {(ts.selectedSkill || ts.codeContext || ts.designLink || (ts.attachedFiles && ts.attachedFiles.length > 0)) && (
                <div style={{ padding: "8px 12px 0", display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {ts.selectedSkill && (
                    <ContextPill
                      icon="⚡" label={ts.selectedSkill.name}
                      badge={ts.selectedSkill.content ? "已加载" : undefined}
                      color={{ bg: "#eff0fb", border: "#c7c9ef", text: "#3a3a8a", dot: "#9090c0" }}
                      onRemove={() => updateTs(activeTabId, { selectedSkill: null })}
                    />
                  )}
                  {ts.codeContext && ts.codeContext.length > 0 && (
                    <ContextPill
                      icon="🗂️"
                      label={ts.codeContext.length === 1 ? (ts.codeContext[0].filename || "代码") : `${ts.codeContext.length} 个文件`}
                      badge={ts.codeContext.length === 1 ? `${ts.codeContext[0].content.split("\n").length} 行` : undefined}
                      color={{ bg: "#f0f8f0", border: "#b8d8b8", text: "#2a5a2a", dot: "#5a9a5a" }}
                      onRemove={() => updateTs(activeTabId, { codeContext: null })}
                      onClick={() => setCodeModalOpen(true)}
                    />
                  )}
                  {ts.designLink && (
                    <ContextPill
                      icon="🔗" label={(() => { try { return new URL(ts.designLink).hostname } catch { return ts.designLink.slice(0, 30) } })()}
                      color={{ bg: "#fff8f0", border: "#e8d0b0", text: "#5a3a00", dot: "#c07820" }}
                      onRemove={() => updateTs(activeTabId, { designLink: null })}
                      onClick={openReferenceLinkModal}
                    />
                  )}
                  {ts.attachedFiles && ts.attachedFiles.map((f, idx) => (
                    <ContextPill
                      key={f.filePath}
                      icon="📄"
                      label={(f.filename.length > 28 ? f.filename.slice(0, 25) + "…" + f.filename.slice(f.filename.lastIndexOf(".")) : f.filename) + (f.truncated ? " ⚠️" : "")}
                      badge={`${f.content.length.toLocaleString()} 字符`}
                      color={{ bg: "#f5f5ff", border: "#d0d0ef", text: "#3a3a6a", dot: "#9090c0" }}
                      onRemove={() => updateTs(activeTabId, (prev) => {
                        const remaining = (prev.attachedFiles ?? []).filter((_, i) => i !== idx)
                        return { attachedFiles: remaining.length > 0 ? remaining : null }
                      })}
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
                placeholder={ts.attachedImage ? "补充说明，如「还原这个页面」或「修改颜色为蓝色」…（可选）" : "描述你想创建的设计… (输入 / 选择技能)"}
                rows={2}
                style={S.textarea}
                disabled={isBlocked}
              />
              <div style={S.inputToolbar}>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <ToolbarIcon
                    title="附加文档（txt / md / csv / docx / xlsx）"
                    onClick={handleDocAttach}
                  >{attachmentLoading ? "⏳" : "📎"}</ToolbarIcon>
                  <ToolbarIcon
                    title="关联代码（ts / tsx / js / css / py 等）"
                    onClick={() => setCodeModalOpen(true)}
                  >🗂️</ToolbarIcon>
                  <ToolbarIcon
                    title="上传截图"
                    onClick={() => fileInputRef.current?.click()}
                  >📷</ToolbarIcon>
                  {/* Model selector */}
                  {availableModels.length > 0 && (
                    <ModelSelector
                      models={availableModels}
                      selectedId={ts.selectedModelId}
                      onChange={(id) => {
                        updateTs(activeTabId, { selectedModelId: id })
                        try {
                          localStorage.setItem(DESIGN_LAST_MODEL_KEY, id)
                        } catch {
                          // Ignore storage errors; the selection still applies to this session.
                        }
                      }}
                    />
                  )}
                </div>
                {isGenerating ? (
                  <button onClick={handleCancel} style={S.cancelBtn}>■ Stop</button>
                ) : ts.generationState === "error" && ts.retryPrompt ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      onClick={handleRetry}
                      style={{ ...S.cancelBtn, background: "#fff3e0", color: "#c05800", border: "1px solid #f0c070" }}
                    >🔄 重试</button>
                    <button
                      onClick={handleSend}
                      disabled={!inputValue.trim() && !ts.attachedImage}
                      style={{
                        ...S.sendBtn,
                        background: inputValue.trim() || ts.attachedImage ? "#cc785c" : "#e8b9a8",
                        cursor: inputValue.trim() || ts.attachedImage ? "pointer" : "default",
                      }}
                    >▶ Send</button>
                  </div>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={(!inputValue.trim() && !ts.attachedImage) || isBlocked}
                    style={{
                      ...S.sendBtn,
                      background: (inputValue.trim() || ts.attachedImage) && !isBlocked ? "#cc785c" : "#e8b9a8",
                      cursor: (inputValue.trim() || ts.attachedImage) && !isBlocked ? "pointer" : "default",
                    }}
                  >
                    ▶ Send
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
                    ? (state.variations.find((v) => v.id === state.activeVariationId)?.html ?? state.html)
                    : state.html
                  if (displayHtml) {
                    iframe.srcdoc = displayHtml
                  }
                }
                updateTs(activeTabId, (prev) => ({ reloadKey: prev.reloadKey + 1 }))
              }}
            >↻</button>

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
                  <span style={{ fontSize: 13, fontWeight: 500, color: tweaksOn ? "#1a1a1a" : "#8a8a8a" }}>Tweaks</span>
                  <button
                    onClick={() => { setTweaksOn((v) => !v); setActiveMode(null) }}
                    style={{ ...S.toggleTrack, background: tweaksOn ? "#1a1a1a" : "#d4d2cc" }}
                    title={tweaksOn ? "Disable Tweaks" : "Enable Tweaks"}
                  >
                    <span style={{ ...S.toggleThumb, transform: tweaksOn ? "translateX(14px)" : "translateX(0)" }} />
                  </button>
                </div>

                {tweaksOn && (
                  <>
                    <div style={S.tweaksDivider} />
                    <TweaksBtn label="注释" icon={<CommentIcon active={activeMode === "comment"} />} active={activeMode === "comment"} onClick={() => setActiveMode(activeMode === "comment" ? null : "comment")} />
                    <TweaksBtn label="编辑" icon={<EditIcon    active={activeMode === "edit"}    />} active={activeMode === "edit"}    onClick={() => setActiveMode(activeMode === "edit"    ? null : "edit")}    />
                    <TweaksBtn label="绘制" icon={<DrawIcon active={activeMode === "draw"} />} active={activeMode === "draw"} onClick={() => setActiveMode(activeMode === "draw" ? null : "draw")} />
                  </>
                )}

                <div style={S.tweaksDivider} />
                {/* Zoom */}
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <button onClick={() => setZoom((z) => Math.max(25, z - 25))} style={S.zoomBtn}>−</button>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "#4a4a4a", minWidth: 36, textAlign: "center" }}>{zoom}%</span>
                  <button onClick={() => setZoom((z) => Math.min(200, z + 25))} style={S.zoomBtn}>+</button>
                </div>
                <div style={S.tweaksDivider} />
                <button style={S.canvasActionBtn} onClick={() => downloadHtml(ts.html)}>⬇ 导出</button>
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
                      <span style={{ fontSize: 14, color: "#8a8a8a" }}>Generating variations…</span>
                    </div>
                  </div>
                ) : ts.html ? (
                  (() => {
                    // Resolve which HTML to show: active variation or full HTML
                    const displayHtml = ts.activeVariationId
                      ? (ts.variations.find((v) => v.id === ts.activeVariationId)?.html ?? ts.html)
                      : ts.html
                    const activeVar = ts.variations.find((v) => v.id === ts.activeVariationId)
                    const varColor  = ts.activeVariationId === "a" ? "#3b82f6"
                      : ts.activeVariationId === "b" ? "#8b5cf6"
                      : ts.activeVariationId === "c" ? "#f59e0b" : undefined

                    return (
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "row" }}>
                  <div
                    ref={canvasContainerRef}
                    style={{ position: "relative", flex: 1, minWidth: 0, height: "100%" }}
                    onClick={() => {
                      if (ts.activeCommentId) updateTs(activeTabId, { activeCommentId: null })
                    }}
                  >
                    {/* Iteration in-progress banner */}
                    {isGenerating && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "8px 16px",
                        background: "rgba(26,26,26,0.82)",
                        backdropFilter: "blur(6px)",
                        color: "#ffffff", fontSize: 13, fontWeight: 500,
                      }}>
                        <PulsingDot />
                        <span>Updating design… previous version shown below</span>
                        <button
                          onClick={handleCancel}
                          style={{ marginLeft: "auto", padding: "3px 12px", fontSize: 12, fontWeight: 600,
                            background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.25)",
                            borderRadius: 6, color: "#fff", cursor: "pointer" }}
                        >
                          Stop
                        </button>
                      </div>
                    )}
                    {/* Active variation label badge */}
                    {activeVar && !isGenerating && (
                      <div style={{
                        position: "absolute", top: 12, right: 16, zIndex: 5,
                        padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                        background: varColor, color: "#fff",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                        pointerEvents: "none",
                      }}>
                        {activeVar.label}
                      </div>
                    )}
                    {/* Scroll wrapper — overflow lives here so the iframe's height: 100% resolves
                        against canvasContainerRef (which has explicit height: "100%") rather than
                        an overflow:auto ancestor (which breaks CSS % height resolution in Chromium). */}
                    <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
                      <iframe
                        ref={iframeRef}
                        key={`${ts.activeVariationId ?? "all"}-${ts.reloadKey}`}
                        srcDoc={displayHtml}
                        style={{
                          display: "block",
                          border: "none",
                          transformOrigin: "top left",
                          transform: `scale(${zoom / 100})`,
                          width: `${10000 / zoom}%`,
                          height: `${10000 / zoom}%`,
                          // Comment + Edit modes need pointer events (scripts handle clicks via postMessage)
                          pointerEvents: (activeMode === null || activeMode === "comment" || activeMode === "edit") ? "auto" : "none",
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
                          updateTs(activeTabId, { iframeScrollX: 0, iframeScrollY: 0, selectedElement: null })
                          // Re-inject mode scripts after iframe reloads (variation switch, etc.)
                          if (activeMode === "comment") injectIntoIframe(iframeRef.current, COMMENT_INJECT)
                          if (activeMode === "edit") injectIntoIframe(iframeRef.current, EDIT_SELECT_INJECT)
                        }}
                      />
                    </div>
                    {(activeMode === "draw" || ts.drawStrokes.length > 0 || ts.drawNotes.length > 0) && (
                      <DrawLayer
                        key={activeMode === "draw" ? "draw-active" : "draw-idle"}
                        active={activeMode === "draw"}
                        mode={ts.drawToolMode}
                        strokes={ts.drawStrokes}
                        notes={ts.drawNotes}
                        draftNote={ts.draftDrawNote}
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
                    {(activeMode === "comment" || ts.comments.length > 0) && (() => {
                      const zf = zoom / 100
                      const cw = canvasContainerRef.current?.clientWidth || 800
                      const ch = canvasContainerRef.current?.clientHeight || 600
                      return ts.comments.map((c, i) => {
                        // Convert document-absolute coords to current canvas-relative % via scroll offset
                        const pinLeft = ((c.pageX - ts.iframeScrollX) * zf / cw) * 100
                        const pinTop  = ((c.pageY - ts.iframeScrollY) * zf / ch) * 100
                        // Hide pins that have scrolled out of the visible canvas area
                        const inView = pinLeft > -6 && pinLeft < 106 && pinTop > -6 && pinTop < 106
                        if (!inView) return null
                        return (
                          <CommentPin
                            key={c.id}
                            comment={c}
                            index={i + 1}
                            pinLeft={pinLeft}
                            pinTop={pinTop}
                            isActive={ts.activeCommentId === c.id}
                            onToggle={() => updateTs(activeTabId, {
                              activeCommentId: ts.activeCommentId === c.id ? null : c.id,
                              draftComment: null,
                            })}
                            onSend={(text) => handleSendComment(c.id, text)}
                            onEdit={(newText) => handleEditComment(c.id, newText)}
                          />
                        )
                      })
                    })()}

                    {/* Draft comment input — shown after clicking canvas */}
                    {ts.draftComment && (() => {
                      const zf = zoom / 100
                      const cw = canvasContainerRef.current?.clientWidth || 800
                      const ch = canvasContainerRef.current?.clientHeight || 600
                      const draftLeft = Math.min(95, Math.max(2,
                        ((ts.draftComment.pageX - ts.iframeScrollX) * zf / cw) * 100
                      ))
                      const draftTop = Math.min(95, Math.max(2,
                        ((ts.draftComment.pageY - ts.iframeScrollY) * zf / ch) * 100
                      ))
                      return (
                        <CommentDraftInput
                          x={draftLeft}
                          y={draftTop}
                          elementDesc={ts.draftComment.elementDesc}
                          onSubmit={(text) => {
                            if (!text.trim()) { updateTs(activeTabId, { draftComment: null }); return }
                            const newComment: CommentItem = {
                              id: uuid(),
                              pageX: ts.draftComment!.pageX,
                              pageY: ts.draftComment!.pageY,
                              text: text.trim(),
                              elementDesc: ts.draftComment!.elementDesc,
                              createdAt: Date.now(),
                            }
                            updateTs(activeTabId, (prev) => ({
                              comments: [...prev.comments, newComment],
                              draftComment: null,
                              activeCommentId: newComment.id,
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
                      <div style={{
                        position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
                        display: "flex", alignItems: "center", gap: 10,
                        padding: ts.comments.length > 0 ? "8px 8px 8px 16px" : "6px 16px",
                        borderRadius: 999,
                        background: "rgba(26,26,26,0.82)", backdropFilter: "blur(8px)",
                        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
                        whiteSpace: "nowrap",
                      }}>
                        <span style={{ fontSize: 12, fontWeight: 500, color: ts.comments.length > 0 ? "#d1d5db" : "#fff" }}>
                          {ts.comments.length === 0
                            ? "点击元素添加批注"
                            : ts.comments.length === 1
                              ? "1 条批注已保存"
                              : `${ts.comments.length} 条批注已保存`}
                        </span>
                        {ts.comments.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleApplyComments() }}
                            style={{
                              padding: "5px 14px", borderRadius: 999,
                              background: "#cc785c", border: "none",
                              fontSize: 12, fontWeight: 700, color: "#fff",
                              cursor: "pointer", fontFamily: "inherit",
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
                        onPositionChange={(position) => updateTs(activeTabId, { variationPanelPosition: position })}
                        onSelect={(id) => updateTs(activeTabId, { activeVariationId: id, rightTab: "design" })}
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
// Sub-components
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────

function downloadHtml(html: string) {
  const blob = new Blob([html], { type: "text/html" })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href = url; a.download = "design.html"; a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────
// Comment Pin — positioned pin with expand-on-click popover
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
