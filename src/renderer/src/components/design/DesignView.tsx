import React, { useState, useRef, useCallback, useEffect } from "react"
import { v4 as uuid } from "uuid"
import type { FileAttachment } from "@/types"
import { getToolLabel } from "@/lib/tool-labels"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface ChatTab {
  id: string
  label: string
}

interface MessageAttachment {
  filename: string
  kind: "code" | "doc"     // code = from codeContext/🗂️, doc = from attachedFiles/📎
  meta?: string            // e.g. "1359 行" or "6,709 字符"
}

interface Message {
  role: "user" | "assistant" | "questions-prompt"
  content: string
  tags?: string[]           // pill tags shown after question phase for user message
  skillName?: string        // skill applied to this message — shown as a styled pill
  attachments?: MessageAttachment[]  // files included with this message
  isStreaming?: boolean
  isIteration?: boolean     // true = follow-up iteration, false = first generation
  imageUrl?: string         // data URL for screenshot attached to this message
  executionEvents?: DesignExecutionEvent[]
}

interface QuestionDef {
  id: string
  type: "text" | "textarea" | "chips"
  label: string
  hint?: string
  options?: string[]
  multi?: boolean   // chips: allow multiple selections
}

type RightPanelTab = "design" | "questions"
type GenerationState = "idle" | "asking" | "questions_ready" | "generating" | "done" | "error"

type AnswerValue = string | string[]

interface VariationItem {
  id: string          // 'a' | 'b' | 'c'
  label: string       // 'Variation A' etc.
  html: string        // standalone full HTML for this variant
}

interface CommentItem {
  id: string
  // Stored as absolute positions in the iframe's document coordinate space (pixels).
  // These are pageX/pageY from the click event — viewport-relative + scroll offset.
  pageX: number
  pageY: number
  text: string
  elementDesc: string
  createdAt: number
}

// Computed styles of a selected element in Edit mode — gathered from the iframe via postMessage
interface ElementStyles {
  fontFamily: string
  fontSize: number
  fontWeight: string
  color: string
  textAlign: string
  lineHeight: number
  letterSpacing: number
  width: number
  height: number
  opacity: number
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
  borderWidth: number
  borderRadius: number
}

interface ModelOption {
  id: string
  name: string
  model: string
}

interface SkillInfo {
  name: string
  description: string
  path: string
  content?: string   // SKILL.md content, loaded on selection
}

interface DesignSkillReference {
  name: string
  path: string
}

function getPathName(filePath: string | null): string {
  if (!filePath) return ""
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath
}

type DesignApprovalDecision = "approve" | "approve_session" | "approve_permanent" | "reject"
type DesignExecutionStatus = "running" | "success" | "error"

interface DesignExecutionEvent {
  kind: "tool_call" | "tool_result" | "used_skill"
  id?: string
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  content?: string
  isError?: boolean
  status?: DesignExecutionStatus
  timestamp: number
}

interface DesignApprovalRequest {
  _orchestratorRequestId?: string
  _approvalTypes?: DesignApprovalDecision[]
  operation?: string
  command?: string
  code?: string
  filePath?: string
  reason?: string
  _retryReason?: string
  tool_call?: {
    id?: string
    name?: string
    args?: Record<string, unknown>
  }
  params?: Record<string, unknown>
  timeoutMs?: number
}

interface TabState {
  messages: Message[]
  html: string
  generationState: GenerationState
  questions: QuestionDef[]
  answers: Record<string, AnswerValue>
  originalPrompt: string
  rightTab: RightPanelTab
  variations: VariationItem[]
  activeVariationId: string | null  // null = show full html; 'a'|'b'|'c' = show that variant
  selectedModelId: string | null
  // Per-tab canvas controls
  tweaksOn: boolean
  activeMode: "comment" | "edit" | "draw" | null
  zoom: number
  // Per-tab input
  inputValue: string
  // Per-tab comments
  comments: CommentItem[]
  // draftComment uses pageX/pageY (document coords) same as CommentItem
  draftComment: { pageX: number; pageY: number; elementDesc: string } | null
  activeCommentId: string | null
  // Iframe scroll position — updated continuously via __iframe_scroll postMessage
  iframeScrollX: number
  iframeScrollY: number
  // Edit mode
  editModeAvailable: boolean   // set true when iframe posts __edit_mode_available
  // The currently selected element in Edit mode (click-to-select in iframe)
  selectedElement: { edId: string; tagName: string; styles: ElementStyles } | null
  // Screenshot attachment — image awaiting send
  attachedImage: { base64: string; mimeType: string; previewUrl: string } | null
  // Incrementing counter — changing it forces the iframe to remount (reload)
  reloadKey: number
  // Currently applied skill (via "/" slash command)
  selectedSkill: SkillInfo | null
  // Code context attached by user
  codeContext: Array<{ filename: string; content: string }> | null
  // Design reference link attached by user
  designLink: string | null
  // Generic file attachments — reuses ChatContainer's FileAttachment via window.api.file
  attachedFiles: FileAttachment[] | null
  // Retry support — stores the last prompt sent to startGeneration
  retryPrompt: string | null
  retryIsIteration: boolean
  retryCleanMsg: string | null
  retrySkill: DesignSkillReference | null
  // Multi-turn conversation history for the API (user+assistant pairs, sans HTML)
  // Source of truth for multi-turn is LangGraph checkpoint; this is for display / session backup.
  apiHistory: Array<{ role: "user" | "assistant"; content: string }>
  pendingApproval: DesignApprovalRequest | null
}

function makeTabState(): TabState {
  return {
    messages: [],
    html: "",
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
    apiHistory: [],
    pendingApproval: null,
  }
}

function makeDesignAgentThreadId(tabId: string): string {
  const safeTabId = String(tabId || "tab")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "") || "tab"
  return `design_${safeTabId}`.slice(0, 120)
}

function getCurrentDesignHtml(state: TabState | undefined): string {
  if (!state) return ""
  if (state.activeVariationId) {
    const variationHtml = state.variations.find((v) => v.id === state.activeVariationId)?.html
    if (variationHtml?.trim()) return variationHtml
  }
  return state.html?.trim() ?? ""
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

let tabCounter = 1

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
  variations: Array<{ id: string; label: string; html: string }>
  activeVariationId: string | null
  selectedModelId: string | null
  tweaksOn: boolean
  zoom: number
  comments: CommentItem[]
  codeContext: Array<{ filename: string; content: string }> | null
  designLink: string | null
  rightTab: RightPanelTab
  apiHistory?: Array<{ role: "user" | "assistant"; content: string }>
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
    variations:        ts.variations.map((v) => ({ id: v.id, label: v.label, html: v.html.slice(0, MAX_HTML_BYTES) })),
    activeVariationId: ts.activeVariationId,
    selectedModelId:   ts.selectedModelId,
    tweaksOn:          ts.tweaksOn,
    zoom:              ts.zoom,
    comments:          ts.comments,
    codeContext:       ts.codeContext,
    designLink:        ts.designLink,
    rightTab:          ts.rightTab,
    apiHistory:        ts.apiHistory,
  }
}

function deserializeTs(p: PersistedTabState): TabState {
  return {
    ...makeTabState(),
    ...p,
    apiHistory:      p.apiHistory ?? [],
    generationState: "idle",  // always reset — never restore mid-stream
    activeMode: null,
    inputValue: "",
    reloadKey: 1,             // non-zero so iframe loads on restore
  }
}

function defaultSession() {
  return {
    chatTabs: [{ id: "chat-1", label: "Chat" }] as ChatTab[],
    activeTabId: "chat-1",
    tabStates: { "chat-1": makeTabState() } as Record<string, TabState>,
  }
}

// ── Per-session storage ───────────────────────────────────
const SESSION_INDEX_KEY  = "design_index_v1"
const SESSION_LAST_KEY   = "design_last_session"
const sessionDataKey     = (id: string) => `design_session_v2_${id}`

interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

function parsePersistedSession(raw: string): ReturnType<typeof defaultSession> {
  const data: PersistedSession = JSON.parse(raw)
  if (!Array.isArray(data.chatTabs) || !data.chatTabs.length || !data.activeTabId) return defaultSession()
  data.chatTabs.forEach((t) => {
    const m = t.id.match(/^chat-(\d+)$/)
    if (m) tabCounter = Math.max(tabCounter, parseInt(m[1]))
  })
  const restoredStates: Record<string, TabState> = {}
  for (const [id, st] of Object.entries(data.tabStates ?? {})) {
    restoredStates[id] = deserializeTs(st)
  }
  data.chatTabs.forEach((t) => {
    if (!restoredStates[t.id]) restoredStates[t.id] = makeTabState()
  })
  return { chatTabs: data.chatTabs, activeTabId: data.activeTabId, tabStates: restoredStates }
}

function loadSessionById(id: string): ReturnType<typeof defaultSession> {
  try {
    const raw = localStorage.getItem(sessionDataKey(id))
    if (!raw) return defaultSession()
    return parsePersistedSession(raw)
  } catch { return defaultSession() }
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
  } catch { return [] }
}

function saveIndex(index: SessionMeta[]) {
  try { localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(index)) } catch {}
}

function updateIndexMeta(id: string, patch: Partial<SessionMeta>) {
  try {
    const index = loadIndex()
    const i = index.findIndex((m) => m.id === id)
    if (i >= 0) {
      index[i] = { ...index[i], ...patch }
      saveIndex(index)
    }
  } catch {}
}

const VARIATION_COLORS: Record<string, string> = {
  a: "#3b82f6",
  b: "#8b5cf6",
  c: "#f59e0b",
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

  // Load persisted session once (ref prevents re-computation on re-renders)
  const _initRef = useRef<ReturnType<typeof loadSessionById> | null>(null)
  if (_initRef.current === null) {
    const sid = localStorage.getItem(SESSION_LAST_KEY)
    _initRef.current = sid ? loadSessionById(sid) : defaultSession()
  }
  const _init = _initRef.current

  const [chatTabs, setChatTabs]       = useState<ChatTab[]>(_init.chatTabs)
  const [activeTabId, setActiveTabId] = useState<string>(_init.activeTabId)
  const [tabStates, setTabStates]     = useState<Record<string, TabState>>(_init.tabStates)
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([])
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([])
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  // Code & link modal state
  const [codeModalOpen, setCodeModalOpen] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkModalText, setLinkModalText] = useState("")
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
  const activeTabIdRef    = useRef(activeTabId)
  const fileInputRef      = useRef<HTMLInputElement>(null)   // images only (screenshot / 📷)

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
    updateTs(activeTabId, { activeMode: val })
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

  // ── Keep activeTabIdRef in sync ───────────────────────────
  useEffect(() => { activeTabIdRef.current = activeTabId }, [activeTabId])

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
          chatTabs,
          activeTabId,
          tabStates: Object.fromEntries(
            Object.entries(tabStates).map(([id, s]) => [id, serializeTs(s)])
          ),
        }
        localStorage.setItem(sessionDataKey(currentSessionId), JSON.stringify(payload))
        // Update index metadata (title from first message, updatedAt)
        const firstTab = chatTabs[0]
        const firstState = tabStates[firstTab?.id]
        const firstUserMsg = firstState?.messages?.find((m) => m.role === "user")
        const autoTitle = firstUserMsg ? (firstUserMsg.content as string).slice(0, 24) : "新设计"
        updateIndexMeta(currentSessionId, { updatedAt: Date.now(), title: autoTitle })
        setSessionIndex(loadIndex())
      } catch {}
    }, 1500)
    return () => { if (_persistTimerRef.current) clearTimeout(_persistTimerRef.current) }
  }, [chatTabs, activeTabId, tabStates, currentSessionId])

  // ── Session navigation ─────────────────────────────────────
  const openSession = useCallback((id: string) => {
    const session = loadSessionById(id)
    setChatTabs(session.chatTabs)
    setActiveTabId(session.activeTabId)
    setTabStates(session.tabStates)
    setCurrentSessionId(id)
    localStorage.setItem(SESSION_LAST_KEY, id)
  }, [])

  const newSession = useCallback(() => {
    const id = `ds_${uuid().slice(0, 8)}`
    const session = defaultSession()
    setChatTabs(session.chatTabs)
    setActiveTabId(session.activeTabId)
    setTabStates(session.tabStates)
    setCurrentSessionId(id)
    localStorage.setItem(SESSION_LAST_KEY, id)
    const meta: SessionMeta = { id, title: "新设计", createdAt: Date.now(), updatedAt: Date.now() }
    setSessionIndex((prev) => {
      const next = [meta, ...prev]
      saveIndex(next)
      return next
    })
  }, [])

  const backToGallery = useCallback(() => {
    setCurrentSessionId(null)
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
        setTabStates((prev) => {
          const state = prev[tabId]
          if (!state) return prev
          const patchedHtml = ensureEditMode(html)
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
        setTabStates((prev) => {
          const state = prev[tabId]
          if (!state) return prev
          // Merge edits into the EDITMODE-BEGIN block of the active HTML
          const targetHtml = state.activeVariationId
            ? (state.variations.find((v) => v.id === state.activeVariationId)?.html ?? state.html)
            : state.html
          const updated = mergeEditModeKeys(targetHtml, edits)
          if (state.activeVariationId) {
            // Update the specific variation's html
            return {
              ...prev,
              [tabId]: {
                ...state,
                variations: state.variations.map((v) =>
                  v.id === state.activeVariationId ? { ...v, html: updated } : v
                ),
              },
            }
          }
          return { ...prev, [tabId]: { ...state, html: updated } }
        })
        return
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [updateTs])

  // ── Tab management ────────────────────────────────────────

  function addTab() {
    tabCounter += 1
    const id = `chat-${tabCounter}`
    setChatTabs((prev) => [...prev, { id, label: "Chat" }])
    setTabStates((prev) => ({ ...prev, [id]: makeTabState() }))
    setActiveTabId(id)
  }

  function closeTab(id: string) {
    // Cancel any running session for the closed tab
    const entry = tabSessionsRef.current.get(id)
    if (entry) {
      entry.cleanup()
      window.api.design.cancel(entry.sessionId).catch(() => {})
      tabSessionsRef.current.delete(id)
    }
    setChatTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      if (activeTabId === id && next.length > 0) setActiveTabId(next[next.length - 1].id)
      return next
    })
    setTabStates((prev) => { const n = { ...prev }; delete n[id]; return n })
  }

  function switchTab(id: string) {
    // Each tab runs independently — do NOT cancel the previous tab's session
    setActiveTabId(id)
  }

  // ── Ask Questions ─────────────────────────────────────────

  const startAskQuestions = useCallback((prompt: string, tabId: string, modelId?: string) => {
    const sessionId = uuid()
    updateTs(tabId, { generationState: "asking", originalPrompt: prompt, rightTab: "questions", questions: [] })

    // Cancel any existing session for this tab before starting a new one
    const existing = tabSessionsRef.current.get(tabId)
    if (existing) { existing.cleanup(); window.api.design.cancel(existing.sessionId).catch(() => {}) }

    const cleanup = window.api.design.askQuestions(sessionId, prompt, (event) => {
      if (event.type === "done") {
        const qs = Array.isArray(event.questions) ? (event.questions as QuestionDef[]) : []
        updateTs(tabId, (prev) => ({
          generationState: "questions_ready",
          questions: qs,
          rightTab: "questions",   // re-assert — guards against any interleaved update
          messages: [
            ...prev.messages,
            { role: "questions-prompt" as const, content: "请补充相关问题 →" },
          ],
        }))
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "error") {
        updateTs(tabId, (prev) => ({
          generationState: "error",
          messages: [
            ...prev.messages,
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
    // context summarisation. tabId = LangGraph thread ID → native multi-turn.
    const agentThreadId = makeDesignAgentThreadId(tabId)
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

    const onEvent = (event: {
      type: string
      token?: string
      html?: string
      error?: string
      event?: unknown
    }) => {
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
        window.api.design.storeHtml(tabId, patchedHtml).catch(() => {})

        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          const doneLabel = variations.length > 0
            ? `✓ ${isIteration ? "Design updated" : "Design generated"} — ${variations.length} variations`
            : isIteration ? "✓ Design updated" : "✓ Design generated"
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: doneLabel, isStreaming: false }
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
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false }
          }
          return { generationState: "error", messages: msgs }
        })
        cleanup()
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false }
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
      workspacePath ?? undefined
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
      if (event.type === "done" && event.html) {
        const patchedHtml = ensureEditMode(event.html)
        // Store full HTML in main process so subsequent text iterations can reference it
        window.api.design.storeHtml(tabId, patchedHtml).catch(() => {})
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.role === "assistant") {
            msgs[last] = { ...msgs[last], content: "✓ 设计已生成", isStreaming: false }
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
            msgs[last] = { ...msgs[last], content: `❌ ${event.error ?? "Unknown error"}`, isStreaming: false }
          }
          return { generationState: "error", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      } else if (event.type === "cancelled") {
        updateTs(tabId, (prev) => {
          const msgs = [...prev.messages]
          const last = msgs.length - 1
          if (msgs[last]?.isStreaming) msgs[last] = { ...msgs[last], isStreaming: false }
          return { generationState: "idle", messages: msgs }
        })
        tabSessionsRef.current.delete(tabId)
      }
    }, modelId)
    tabSessionsRef.current.set(tabId, { cleanup, sessionId })
  }, [updateTs])

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
    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg)
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
    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg)
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

    startGeneration(prompt, tabId, true, state?.selectedModelId ?? undefined, cleanMsg)
  }, [activeTabId, tabStates, updateTs, startGeneration, buildCommentPrompt])

  // ── Send message ──────────────────────────────────────────

  const handleSend = useCallback(() => {
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
    const existing = tabStates[tabId]?.messages ?? []

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
    const codeSuffix = codeContext && codeContext.length > 0
      ? "\n\n---\n[Code context — " + codeContext.length + " file(s)]\n" +
        codeContext.map((f) => {
          const ext = f.filename.split(".").pop() ?? ""
          return "```" + ext + "\n// " + f.filename + "\n" + f.content.slice(0, 2000) + "\n```"
        }).join("\n\n")
      : ""
    const linkSuffix = designLink
      ? `\n\n---\n[Design reference URL: ${designLink}]\nPlease use this as a visual/layout reference for the design.`
      : ""
    const filesSuffix = attachedFiles && attachedFiles.length > 0
      ? "\n\n---\n[Attached files — " + attachedFiles.length + " file(s)]\n" +
        attachedFiles.map((f) =>
          `### ${f.filename}${f.truncated ? " (truncated)" : ""}\n${f.content}`
        ).join("\n\n")
      : ""
    const contextSuffix = skillContext + codeSuffix + linkSuffix + filesSuffix
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
          skillReference
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

    // Auto-label tab from its first prompt (for history readability)
    if (existing.length === 0) {
      const label = prompt.trim().slice(0, 24) + (prompt.length > 24 ? "…" : "")
      setChatTabs((prev) => prev.map((t) => t.id === tabId ? { ...t, label } : t))
    }

    // First message with an explicit skill → run the skill workflow directly.
    // Skill-authored flows should not be interrupted by Design's clarifying-question step;
    // startGeneration still patches the output with EDITMODE so Tweaks remains available.
    if (existing.length === 0) {
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

      startGeneration(
        iterationPrompt + contextSuffix,
        tabId,
        /* isIteration */ !!contextHtml,
        selectedModelId,
        prompt,   // clean user message for apiHistory recording
        undefined,
        skillReference
      )
    }
  }, [activeTabId, tabStates, updateTs, startAskQuestions, startGeneration, startGenerationFromImage])

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

    const enrichedPrompt = `${originalPrompt}\n\n---\nUser's answers to clarifying questions:\n${answerLines}\n\nRemember: Generate exactly 2 variations (A / B) within one HTML file.`

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
      if (e.key === "Enter" && filteredSkills.length > 0) {
        e.preventDefault()
        handleSkillSelect(filteredSkills[0])
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

  // ── Render ─────────────────────────────────────────────────

  // Show gallery when no session is active
  if (currentSessionId === null) {
    return (
      <DesignGallery
        sessionIndex={sessionIndex}
        onOpen={openSession}
        onNew={newSession}
        onDelete={deleteSession}
      />
    )
  }

  return (
    <div style={S.root}>
      {/* Code & Link modals — rendered at root so they overlay everything */}
      <CodeModal
        open={codeModalOpen}
        initialFiles={ts.codeContext ?? []}
        onConfirm={(files) => {
          updateTs(activeTabId, { codeContext: files.length > 0 ? files : null })
          setCodeModalOpen(false)
        }}
        onClose={() => setCodeModalOpen(false)}
      />
      <LinkModal
        open={linkModalOpen}
        url={linkModalText}
        onUrlChange={setLinkModalText}
        onConfirm={() => {
          updateTs(activeTabId, { designLink: linkModalText.trim() })
          setLinkModalOpen(false)
        }}
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
            title={workspacePath ?? "选择工作目录"}
          >
            <span style={S.workspaceIcon}>▣</span>
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
          {/* Tab Bar */}
          <div style={S.tabBar}>
            {chatTabs.map((tab) => (
              <TabButton
                key={tab.id}
                label={tab.label}
                active={activeTabId === tab.id}
                closable={chatTabs.length > 1}
                onClick={() => switchTab(tab.id)}
                onClose={() => closeTab(tab.id)}
              />
            ))}
            <button onClick={addTab} style={S.addTabBtn} title="New chat">+</button>
          </div>

          {/* Chat Body */}
          <div style={S.chatBody}>
            {ts.messages.length === 0 ? (
              <EmptyState
                onUploadScreenshot={() => fileInputRef.current?.click()}
                onAttachCode={() => setCodeModalOpen(true)}
                onAttachLink={() => { setLinkModalText(""); setLinkModalOpen(true) }}
              />
            ) : (
              <div style={S.messageList}>
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
                  ⚡ 技能 — 按 ↵ 选第一个，Esc 取消
                </div>
                {filteredSkills.map((skill, i) => (
                  <div
                    key={skill.name}
                    onClick={() => handleSkillSelect(skill)}
                    style={{
                      padding: "8px 12px", cursor: "pointer",
                      background: i === 0 ? "#f8f7f4" : "transparent",
                      borderBottom: i < filteredSkills.length - 1 ? "1px solid #f4f3f0" : "none",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f2ee")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = i === 0 ? "#f8f7f4" : "transparent")}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 14 }}>⚡</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#1a1a1a" }}>{skill.name}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#8a8a8a", marginTop: 2, marginLeft: 20, lineHeight: 1.4 }}>
                      {skill.description.slice(0, 80)}{skill.description.length > 80 ? "…" : ""}
                    </div>
                  </div>
                ))}
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
                      onClick={() => { setLinkModalText(ts.designLink!); setLinkModalOpen(true) }}
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
                        try { localStorage.setItem(DESIGN_LAST_MODEL_KEY, id) } catch {}
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
                        onSelect={(id) => updateTs(activeTabId, { activeVariationId: id, rightTab: "design" })}
                      />
                    )}
                  </div>

                  {/* ── Right Properties Panel (Edit mode) ── */}
                  {activeMode === "edit" && (
                    <ElementPropsPanel
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
// Element Properties Panel — right sidebar in Edit mode
// Light-themed panel matching the Claude design tool style.
// Click any element in the iframe to inspect + edit it live.
// ─────────────────────────────────────────────────────────

/** Inline number input — compact, borderless look, editable on click */
function PNumInput({ value, onChange, suffix, step = 1, min, max, readonly }: {
  value: number; onChange: (v: number) => void
  suffix?: string; step?: number; min?: number; max?: number; readonly?: boolean
}) {
  const [local, setLocal] = React.useState(String(value))
  React.useEffect(() => { setLocal(String(value)) }, [value])
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 1 }}>
      <input
        type="number" value={local} readOnly={readonly}
        step={step} min={min} max={max}
        onChange={(e) => { setLocal(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(n) }}
        onBlur={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) { onChange(n); setLocal(String(n)) } else setLocal(String(value)) }}
        style={{
          background: "transparent", border: "none", outline: "none",
          fontSize: 12, fontWeight: 500, color: readonly ? "#aaa" : "#1a1a1a",
          textAlign: "right", width: "60px", padding: 0, fontFamily: "inherit",
          cursor: readonly ? "default" : "text",
        }}
      />
      {suffix && <span style={{ fontSize: 11, color: "#aaa", flexShrink: 0 }}>{suffix}</span>}
    </div>
  )
}

/** A single property row: "Label ............... Value unit" */
function PropLineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      borderBottom: "1px solid #f0efeb", padding: "0 16px",
      height: 36, gap: 8,
    }}>
      <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 60 }}>{label}</span>
      <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
        {children}
      </div>
    </div>
  )
}

/** Two-column row for paired props: Size/Weight, Width/Height etc. */
function PropPairRow({ left, right }: {
  left: { label: string; children: React.ReactNode }
  right: { label: string; children: React.ReactNode }
}) {
  const half: React.CSSProperties = {
    flex: 1, display: "flex", alignItems: "center",
    padding: "0 12px", height: 36, gap: 6,
  }
  return (
    <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
      <div style={{ ...half, borderRight: "1px solid #f0efeb" }}>
        <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 40 }}>{left.label}</span>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>{left.children}</div>
      </div>
      <div style={half}>
        <span style={{ fontSize: 12, color: "#8a8a8a", flexShrink: 0, minWidth: 40 }}>{right.label}</span>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>{right.children}</div>
      </div>
    </div>
  )
}

/** Section header row */
function PropSectionHeader({ label }: { label: string }) {
  return (
    <div style={{
      padding: "10px 16px 6px",
      fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
      color: "#8a8a8a", textTransform: "uppercase",
      background: "#f8f7f5",
      borderBottom: "1px solid #f0efeb",
    }}>
      {label}
    </div>
  )
}

/** Collapsible compound row (Padding / Margin / Border) */
function CompoundRow({ label, summary, expanded, onToggle, children }: {
  label: string; summary: string
  expanded: boolean; onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center",
          borderBottom: "1px solid #f0efeb", padding: "0 16px",
          height: 36, gap: 8, cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, color: "#8a8a8a", flex: 1 }}>{label}</span>
        <span style={{ fontSize: 12, color: "#1a1a1a", fontWeight: 500 }}>{summary}</span>
        <span style={{ fontSize: 10, color: "#aaa", marginLeft: 4 }}>{expanded ? "∧" : "∨"}</span>
      </div>
      {expanded && (
        <div style={{ background: "#f8f7f5" }}>
          {children}
        </div>
      )}
    </>
  )
}

/** TRBL (top/right/bottom/left) sub-rows, shown when compound is expanded */
function TRBLRows({ values, onChange }: {
  values: { t: number; r: number; b: number; l: number }
  onChange: (side: "t" | "r" | "b" | "l", v: number) => void
}) {
  return (
    <>
      <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
        {(["t", "r"] as const).map((side) => (
          <div key={side} style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 12px", height: 32, borderRight: side === "t" ? "1px solid #f0efeb" : "none" }}>
            <span style={{ fontSize: 11, color: "#aaa", minWidth: 10 }}>{side.toUpperCase()}</span>
            <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
              <PNumInput value={values[side]} suffix="px" onChange={(v) => onChange(side, v)} />
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", borderBottom: "1px solid #f0efeb" }}>
        {(["b", "l"] as const).map((side) => (
          <div key={side} style={{ flex: 1, display: "flex", alignItems: "center", padding: "0 12px", height: 32, borderRight: side === "b" ? "1px solid #f0efeb" : "none" }}>
            <span style={{ fontSize: 11, color: "#aaa", minWidth: 10 }}>{side.toUpperCase()}</span>
            <div style={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
              <PNumInput value={values[side]} suffix="px" onChange={(v) => onChange(side, v)} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function ElementPropsPanel({
  selectedElement,
  onStyleChange,
}: {
  selectedElement: { edId: string; tagName: string; styles: ElementStyles } | null
  onStyleChange: (property: string, value: unknown) => void
}) {
  const s = selectedElement?.styles
  const [paddingOpen, setPaddingOpen] = React.useState(false)
  const [marginOpen,  setMarginOpen]  = React.useState(true)
  const [borderOpen,  setBorderOpen]  = React.useState(false)

  // Reset open states when element changes
  React.useEffect(() => {
    setPaddingOpen(false); setMarginOpen(true); setBorderOpen(false)
  }, [selectedElement?.edId])

  const ch = (prop: string) => (v: unknown) => onStyleChange(prop, v)

  const paddingSummary = s
    ? [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].every(v => v === s.paddingTop)
      ? `${s.paddingTop} px`
      : `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} px`
    : "0 px"

  const marginSummary = s
    ? [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].every(v => v === s.marginTop)
      ? `${s.marginTop} px`
      : `${s.marginTop} ${s.marginRight} ${s.marginBottom} ${s.marginLeft} px`
    : "0 px"

  return (
    <div style={{
      width: 260, flexShrink: 0,
      background: "#ffffff", borderLeft: "1px solid #e8e6e0",
      display: "flex", flexDirection: "column", overflow: "hidden",
      fontFamily: "'Inter', -apple-system, sans-serif",
    }}>
      {/* Header */}
      <div style={{
        padding: "0 16px", height: 44,
        borderBottom: "1px solid #e8e6e0",
        display: "flex", alignItems: "center", flexShrink: 0,
        background: "#ffffff",
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>
          {selectedElement ? `<${selectedElement.tagName}>` : "Properties"}
        </span>
      </div>

      {!s ? (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, background: "#f8f7f5" }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" opacity={0.3}>
            <rect x="3" y="3" width="18" height="18" rx="2" stroke="#1a1a1a" strokeWidth="1.5"/>
            <path d="M9 9l6 6M15 9l-6 6" stroke="#1a1a1a" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <p style={{ color: "#8a8a8a", fontSize: 12, textAlign: "center", lineHeight: 1.7, margin: 0 }}>
            点击设计中的任意元素<br />即可查看并编辑属性
          </p>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", background: "#ffffff" }}>

          {/* ── TYPOGRAPHY ── */}
          <PropSectionHeader label="Typography" />

          <PropLineRow label="Font">
            <input
              type="text"
              defaultValue={s.fontFamily}
              onBlur={(e) => onStyleChange("fontFamily", e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { onStyleChange("fontFamily", (e.target as HTMLInputElement).value); (e.target as HTMLInputElement).blur() } }}
              style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, fontWeight: 500, color: "#1a1a1a", textAlign: "right", fontFamily: "inherit", width: "140px" }}
            />
          </PropLineRow>

          <PropPairRow
            left={{ label: "Size", children: <PNumInput value={s.fontSize} suffix="px" step={0.5} onChange={ch("fontSize")} /> }}
            right={{ label: "Weight", children: <PNumInput value={parseInt(s.fontWeight) || 400} step={100} min={100} max={900} onChange={(v) => onStyleChange("fontWeight", String(v))} /> }}
          />

          <PropLineRow label="Color">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : "#000000"}
                onChange={(e) => onStyleChange("color", e.target.value)}
                style={{ width: 20, height: 20, border: "1px solid #e0ded8", padding: 1, borderRadius: 4, cursor: "pointer", background: "none", flexShrink: 0 }}
              />
              <input
                type="text"
                value={s.color}
                onChange={(e) => onStyleChange("color", e.target.value)}
                style={{ background: "transparent", border: "none", outline: "none", fontSize: 12, fontWeight: 500, color: "#1a1a1a", textAlign: "right", fontFamily: "monospace", width: "72px" }}
              />
            </div>
          </PropLineRow>

          <PropLineRow label="Align">
            <div style={{ display: "flex", gap: 2 }}>
              {[["left","L"],["center","C"],["right","R"],["justify","J"]].map(([v, lbl]) => (
                <button key={v} onClick={() => onStyleChange("textAlign", v)} style={{
                  width: 26, height: 22, fontSize: 10, fontWeight: 600,
                  background: s.textAlign === v ? "#1a1a1a" : "#f0efeb",
                  border: "none", borderRadius: 4, cursor: "pointer",
                  color: s.textAlign === v ? "#fff" : "#6a6a6a", fontFamily: "inherit",
                }}>{lbl}</button>
              ))}
            </div>
          </PropLineRow>

          <PropPairRow
            left={{ label: "Line", children: <PNumInput value={s.lineHeight} step={0.05} onChange={ch("lineHeight")} /> }}
            right={{ label: "Tracking", children: <PNumInput value={s.letterSpacing} suffix="px" step={0.5} onChange={ch("letterSpacing")} /> }}
          />

          {/* ── SIZE ── */}
          <PropSectionHeader label="Size" />
          <PropPairRow
            left={{ label: "Width",  children: <PNumInput value={s.width}  suffix="px" readonly onChange={() => {}} /> }}
            right={{ label: "Height", children: <PNumInput value={s.height} suffix="px" readonly onChange={() => {}} /> }}
          />

          {/* ── BOX ── */}
          <PropSectionHeader label="Box" />

          <PropLineRow label="Opacity">
            <PNumInput value={s.opacity} step={0.05} min={0} max={1} onChange={ch("opacity")} />
          </PropLineRow>

          <CompoundRow
            label="Padding" summary={paddingSummary}
            expanded={paddingOpen} onToggle={() => setPaddingOpen(v => !v)}
          >
            <TRBLRows
              values={{ t: s.paddingTop, r: s.paddingRight, b: s.paddingBottom, l: s.paddingLeft }}
              onChange={(side, v) => onStyleChange({ t:"paddingTop", r:"paddingRight", b:"paddingBottom", l:"paddingLeft" }[side]!, v)}
            />
          </CompoundRow>

          <CompoundRow
            label="Margin" summary={marginSummary}
            expanded={marginOpen} onToggle={() => setMarginOpen(v => !v)}
          >
            <TRBLRows
              values={{ t: s.marginTop, r: s.marginRight, b: s.marginBottom, l: s.marginLeft }}
              onChange={(side, v) => onStyleChange({ t:"marginTop", r:"marginRight", b:"marginBottom", l:"marginLeft" }[side]!, v)}
            />
          </CompoundRow>

          <CompoundRow
            label="Border" summary={`${s.borderWidth} px`}
            expanded={borderOpen} onToggle={() => setBorderOpen(v => !v)}
          >
            <PropLineRow label="Width">
              <PNumInput value={s.borderWidth} suffix="px" onChange={ch("borderWidth")} />
            </PropLineRow>
          </CompoundRow>

          <PropLineRow label="Radius">
            <PNumInput value={s.borderRadius} suffix="px" onChange={ch("borderRadius")} />
          </PropLineRow>

        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Floating Tweaks Panel — bottom-right variation switcher
// ─────────────────────────────────────────────────────────

function TweaksFloatingPanel({
  variations,
  activeId,
  onSelect,
}: {
  variations: VariationItem[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div style={{
      position: "absolute",
      bottom: 28,
      right: 28,
      zIndex: 30,
      userSelect: "none",
    }}>
      {collapsed ? (
        /* Collapsed pill */
        <button
          onClick={() => setCollapsed(false)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 16px",
            background: "#1a1a1a",
            borderRadius: 999,
            border: "none", cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            color: "#ffffff", fontSize: 12, fontWeight: 700,
            letterSpacing: "0.06em",
            fontFamily: "inherit",
          }}
        >
          <span style={{ fontSize: 10 }}>◈</span>
          TWEAKS
        </button>
      ) : (
        /* Expanded card */
        <div style={{
          background: "#ffffff",
          borderRadius: 20,
          boxShadow: "0 8px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)",
          padding: "20px 22px 18px",
          minWidth: 200,
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: "#1a1a1a", textTransform: "uppercase" }}>
              Tweaks
            </span>
            <button
              onClick={() => setCollapsed(true)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 0 0 8px", fontSize: 16, color: "#8a8a8a", lineHeight: 1, fontFamily: "inherit" }}
            >
              ×
            </button>
          </div>

          {/* Variation label */}
          <div style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500, marginBottom: 10, letterSpacing: "0.02em" }}>
            变体选择
          </div>

          {/* Variation chips */}
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {variations.map((v) => {
              const isActive = activeId === v.id
              const color = VARIATION_COLORS[v.id] ?? "#888"
              return (
                <button
                  key={v.id}
                  onClick={() => onSelect(v.id)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 14px",
                    borderRadius: 12,
                    fontSize: 13, fontWeight: isActive ? 700 : 500,
                    color: isActive ? "#ffffff" : "#1a1a1a",
                    background: isActive ? "#1a1a1a" : "#f5f4f0",
                    border: "none", cursor: "pointer",
                    fontFamily: "inherit",
                    transition: "all 0.12s ease",
                    textAlign: "left" as const,
                  }}
                >
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: isActive ? color : "#c8c6c0",
                    flexShrink: 0,
                    transition: "background 0.12s",
                  }} />
                  {v.label}
                </button>
              )
            })}
          </div>

          {/* Active indicator */}
          {activeId && (
            <div style={{
              marginTop: 14, paddingTop: 12, borderTop: "1px solid #f0efeb",
              fontSize: 11, color: "#8a8a8a", textAlign: "center" as const,
            }}>
              后续追问将迭代此变体
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Questions Panel — rendered in right canvas
// ─────────────────────────────────────────────────────────

function QuestionsPanel({
  questions,
  answers,
  isLoading,
  onAnswer,
  onContinue,
}: {
  questions: QuestionDef[]
  answers: Record<string, AnswerValue>
  isLoading: boolean
  onAnswer: (id: string, value: AnswerValue) => void
  onContinue: () => void
}) {
  // Check if a question has been answered
  function isAnswered(q: QuestionDef): boolean {
    const v = answers[q.id]
    if (!v) return false
    if (Array.isArray(v)) return v.length > 0
    return v.trim().length > 0
  }

  const answeredCount = questions.filter(isAnswered).length
  const allAnswered   = questions.length > 0 && answeredCount === questions.length

  // Toggle a chip option for multi-select
  function toggleChip(qId: string, opt: string, multi: boolean) {
    if (!multi) {
      onAnswer(qId, opt)
      return
    }
    const current = answers[qId]
    const arr: string[] = Array.isArray(current) ? current : (current ? [current as string] : [])
    const next = arr.includes(opt) ? arr.filter((v) => v !== opt) : [...arr, opt]
    onAnswer(qId, next)
  }

  function isChipSelected(qId: string, opt: string): boolean {
    const v = answers[qId]
    if (Array.isArray(v)) return v.includes(opt)
    return v === opt
  }

  if (isLoading) {
    return (
      <div style={{ ...S.canvasEmpty, flexDirection: "column", gap: 12 }}>
        <PulsingDot />
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>Generating questions…</span>
      </div>
    )
  }

  if (questions.length === 0) {
    return (
      <div style={S.canvasEmpty}>
        <span style={{ fontSize: 14, color: "#8a8a8a" }}>No questions generated yet</span>
      </div>
    )
  }

  return (
    <div style={S.questionsContainer}>
      <div style={S.questionsInner}>
        <h2 style={S.questionsTitle}>告诉我更多关于这个设计</h2>

        {questions.map((q) => {
          const answered = isAnswered(q)
          return (
            <div key={q.id} style={{ ...S.questionBlock, opacity: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <label style={S.questionLabel}>{q.label}</label>
                {q.type === "chips" && q.multi && (
                  <span style={{ fontSize: 11, color: "#8a8a8a", background: "#f0efeb", padding: "2px 7px", borderRadius: 999, fontWeight: 500 }}>
                    可多选
                  </span>
                )}
                {answered && (
                  <span style={{ fontSize: 11, color: "#4ade80", marginLeft: "auto" }}>✓</span>
                )}
              </div>
              {q.hint && <p style={S.questionHint}>{q.hint}</p>}

              {q.type === "chips" && q.options ? (
                <div style={S.chipsRow}>
                  {q.options.map((opt) => {
                    const selected = isChipSelected(q.id, opt)
                    return (
                      <button
                        key={opt}
                        onClick={() => toggleChip(q.id, opt, q.multi ?? false)}
                        style={{
                          ...S.chip,
                          background: selected ? "#1a1a1a" : "#ffffff",
                          color: selected ? "#ffffff" : "#1a1a1a",
                          border: selected ? "1px solid #1a1a1a" : "1px solid #d4d2cc",
                          // multi-select: show a subtle checkmark prefix when selected
                          paddingLeft: q.multi && selected ? 10 : undefined,
                        }}
                      >
                        {q.multi && selected && <span style={{ marginRight: 5, fontSize: 11 }}>✓</span>}
                        {opt}
                      </button>
                    )
                  })}
                </div>
              ) : q.type === "textarea" ? (
                <textarea
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="输入你的回答…"
                  rows={3}
                  style={S.questionTextarea}
                />
              ) : (
                <input
                  type="text"
                  value={(answers[q.id] as string) ?? ""}
                  onChange={(e) => onAnswer(q.id, e.target.value)}
                  placeholder="输入你的回答…"
                  style={S.questionInput}
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Footer with Continue */}
      <div style={S.questionsFooter}>
        <span style={{ fontSize: 13, color: "#8a8a8a" }}>
          {allAnswered
            ? "Ready to generate"
            : `${answeredCount} / ${questions.length} answered`}
        </span>
        <button
          onClick={onContinue}
          disabled={!allAnswered}
          style={{
            ...S.continueBtn,
            background: allAnswered ? "#1a1a1a" : "#d4d2cc",
            cursor: allAnswered ? "pointer" : "default",
          }}
        >
          Continue →
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────

function EmptyState({ onUploadScreenshot, onAttachCode, onAttachLink }: {
  onUploadScreenshot: () => void
  onAttachCode: () => void
  onAttachLink: () => void
}) {
  return (
    <div style={S.emptyState}>
      <h2 style={S.emptyTitle}>从上下文开始</h2>
      <p style={S.emptySubtitle}>提供的背景越充分，设计结果越精准。</p>
      <div style={S.contextCards}>
        <ContextCard icon="🖼️" label="上传截图"         onClick={onUploadScreenshot} />
        <ContextCard icon="🗂️" label="关联代码"         onClick={onAttachCode} />
        <ContextCard icon="🔗" label="通过链接关联设计图" onClick={onAttachLink} />
      </div>
    </div>
  )
}

function TabButton({
  label, active, closable, onClick, onClose,
}: {
  label: string; active: boolean; closable?: boolean; onClick: () => void; onClose?: () => void
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 44, borderBottom: active ? "2px solid #1a1a1a" : "2px solid transparent", flexShrink: 0 }}>
      <button
        onClick={onClick}
        style={{ display: "flex", alignItems: "center", padding: closable ? "0 4px 0 12px" : "0 12px", height: "100%", fontSize: 13, fontWeight: active ? 600 : 400, color: active ? "#1a1a1a" : "#8a8a8a", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
      >
        {label}
      </button>
      {closable && (
        <button
          onClick={(e) => { e.stopPropagation(); onClose?.() }}
          style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "#aaa", borderRadius: 3, marginRight: 6, padding: 0 }}
        >×</button>
      )}
    </div>
  )
}

function DesignApprovalBar({
  approval,
  onDecision,
}: {
  approval: DesignApprovalRequest
  onDecision: (decision: DesignApprovalDecision) => void
}) {
  const operation = approval.operation || approval.tool_call?.name || "execute"
  const isFileApproval = operation === "write_file" || operation === "edit_file"
  const isCodeApproval =
    operation === "code_exec" ||
    operation === "prepare_save_code_exec_tool" ||
    operation === "save_code_exec_tool"
  const approvalTypes = approval._approvalTypes ?? ["approve", "approve_session", "approve_permanent", "reject"]
  const args = approval.tool_call?.args ?? {}
  const detail =
    isFileApproval
      ? `${operation === "write_file" ? "写入" : "编辑"}: ${String(approval.filePath || args.filePath || "unknown")}`
      : approval.command
        ? approval.command
        : isCodeApproval
          ? String(approval.code || args.code || "")
          : String(args.command || "unknown command")

  return (
    <div style={{
      margin: "10px 12px 0",
      padding: 12,
      borderRadius: 10,
      border: `1px solid ${isFileApproval ? "#9bbcf0" : isCodeApproval ? "#9fd3b2" : "#efcf8b"}`,
      background: isFileApproval ? "#f2f7ff" : isCodeApproval ? "#f0faf4" : "#fff8e8",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14 }}>{isFileApproval ? "✎" : isCodeApproval ? "{}" : "!"}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2933" }}>
          {operation === "write_file"
            ? "写入文件需要审批"
            : operation === "edit_file"
              ? "编辑文件需要审批"
              : isCodeApproval
                ? "执行脚本需要审批"
                : "命令需要审批"}
        </span>
      </div>
      <pre style={{
        margin: 0,
        maxHeight: 120,
        overflow: "auto",
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.72)",
        color: "#2f3437",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>{detail}</pre>
      {(approval.reason || approval._retryReason) && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45, color: "#6a5a2a" }}>
          {approval._retryReason || approval.reason}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        {approvalTypes.includes("approve") && (
          <button onClick={() => onDecision("approve")} style={{ ...S.approvalPrimaryBtn }}>
            {isFileApproval ? "允许" : isCodeApproval ? "执行" : "运行"}
          </button>
        )}
        {approvalTypes.includes("approve_session") && (
          <button onClick={() => onDecision("approve_session")} style={{ ...S.approvalSessionBtn }}>
            本会话允许
          </button>
        )}
        {approvalTypes.includes("approve_permanent") && (
          <button onClick={() => onDecision("approve_permanent")} style={{ ...S.approvalPermanentBtn }}>
            始终允许
          </button>
        )}
        {approvalTypes.includes("reject") && (
          <button onClick={() => onDecision("reject")} style={{ ...S.approvalRejectBtn }}>
            拒绝
          </button>
        )}
      </div>
    </div>
  )
}

function RightTabBtn({ label, active, onClick, closable }: { label: string; active: boolean; onClick: () => void; closable?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "0 14px", height: 44,
        fontSize: 13, fontWeight: active ? 600 : 400,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#ffffff" : "transparent",
        border: "1px solid",
        borderColor: active ? "#e0ded8" : "transparent",
        borderBottom: active ? "1px solid #ffffff" : "1px solid transparent",
        borderRadius: active ? "8px 8px 0 0" : 0,
        cursor: "pointer", fontFamily: "inherit",
        position: "relative", top: 1,
      }}
    >
      {!active && closable && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />}
      {label}
      {closable && active && <span style={{ fontSize: 12, color: "#aaa", marginLeft: 2 }}>×</span>}
    </button>
  )
}

function ContextCard({ icon, label, hint, onClick }: { icon: string; label: string; hint?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "#ffffff", border: "1px solid #e8e6e0", borderRadius: 24, cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 500, color: "#1a1a1a", textAlign: "left", width: "100%" }}
    >
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {hint && <span style={{ width: 18, height: 18, borderRadius: "50%", border: "1px solid #c0beb8", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#8a8a8a", flexShrink: 0 }}>?</span>}
    </button>
  )
}

// ─────────────────────────────────────────────────────────
// ContextPill — small dismissible tag shown above textarea
// ─────────────────────────────────────────────────────────
function ContextPill({ icon, label, badge, color, onRemove, onClick }: {
  icon: string; label: string; badge?: string
  color: { bg: string; border: string; text: string; dot: string }
  onRemove: () => void
  onClick?: () => void
}) {
  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        background: color.bg, border: `1px solid ${color.border}`,
        borderRadius: 6, padding: "3px 6px 3px 8px",
        cursor: onClick ? "pointer" : "default",
      }}
      onClick={onClick}
    >
      <span style={{ fontSize: 12 }}>{icon}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: color.text }}>{label}</span>
      {badge && <span style={{ fontSize: 10, color: color.text, opacity: 0.6 }}>{badge}</span>}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        style={{
          width: 14, height: 14, borderRadius: "50%",
          background: color.dot, border: "none",
          color: "#fff", fontSize: 9, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          lineHeight: 1, fontFamily: "inherit", padding: 0, marginLeft: 2,
        }}
      >×</button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// CodeModal — multi-file code context: upload files / paste code
// ─────────────────────────────────────────────────────────
type CodeFile = { filename: string; content: string }

function CodeModal({ open, initialFiles, onConfirm, onClose }: {
  open: boolean
  initialFiles: CodeFile[]
  onConfirm: (files: CodeFile[]) => void
  onClose: () => void
}) {
  const [files, setFiles]           = React.useState<CodeFile[]>(initialFiles)
  const [selectedIdx, setSelectedIdx] = React.useState(0)
  const [dragging, setDragging]     = React.useState(false)
  const [editingName, setEditingName] = React.useState(false)
  const [uploading, setUploading]   = React.useState(false)

  // Sync when modal re-opens with new initialFiles
  React.useEffect(() => {
    if (open) { setFiles(initialFiles); setSelectedIdx(0); setEditingName(false) }
  }, [open])  // eslint-disable-line react-hooks/exhaustive-deps

  const selected = files[selectedIdx]

  const mergeCodeFiles = (incoming: CodeFile[]) => {
    setFiles((prev) => {
      const merged = [...prev]
      incoming.forEach((nf) => {
        const existing = merged.findIndex((f) => f.filename === nf.filename)
        if (existing >= 0) merged[existing] = nf
        else merged.push(nf)
      })
      return merged
    })
  }

  // Use Electron's native dialog — avoids the hidden-input backdrop-click race condition
  const handleUploadClick = async () => {
    const result = await window.api.file.selectCode()
    if (result.canceled || result.filePaths.length === 0) return
    setUploading(true)
    try {
      const results = await Promise.all(result.filePaths.map((fp) => window.api.file.readText(fp)))
      const loaded: CodeFile[] = results
        .filter((r): r is { success: true; filename: string; content: string } => r.success && !!r.filename)
        .map((r) => ({ filename: r.filename, content: r.content }))
      if (loaded.length > 0) mergeCodeFiles(loaded)
    } finally {
      setUploading(false)
    }
  }

  // Drag & drop still uses FileReader (drag events don't have the same Electron issue)
  const readFileAsText = (file: File): Promise<CodeFile> =>
    new Promise((res) => {
      const reader = new FileReader()
      reader.onload = (e) => res({ filename: file.name, content: e.target?.result as string ?? "" })
      reader.readAsText(file)
    })

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (!e.dataTransfer.files.length) return
    const loaded = await Promise.all(Array.from(e.dataTransfer.files).map(readFileAsText))
    mergeCodeFiles(loaded)
  }

  const addBlankFile = () => {
    const name = `untitled-${files.length + 1}.ts`
    setFiles((prev) => [...prev, { filename: name, content: "" }])
    setSelectedIdx(files.length)
    setEditingName(true)
  }

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
    setSelectedIdx((prev) => Math.max(0, prev >= idx ? prev - 1 : prev))
  }

  const updateContent = (content: string) => {
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, content } : f))
  }

  const updateFilename = (filename: string) => {
    setFiles((prev) => prev.map((f, i) => i === selectedIdx ? { ...f, filename } : f))
  }

  const totalLines = files.reduce((acc, f) => acc + f.content.split("\n").length, 0)

  if (!open) return null

  const extColor: Record<string, string> = {
    tsx: "#3178c6", ts: "#3178c6", jsx: "#f7a41d", js: "#f7a41d",
    css: "#264de4", scss: "#c6538c", py: "#3572a5", vue: "#41b883",
    html: "#e34c26", json: "#a0522d", md: "#555",
  }
  const getColor = (name: string) => extColor[name.split(".").pop() ?? ""] ?? "#888"

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
      onClick={onClose}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handleDrop(e) }}
    >

      <div
        style={{ background: "#f8f7f4", borderRadius: 16, width: 820, height: 580, display: "flex", flexDirection: "column", boxShadow: "0 12px 48px rgba(0,0,0,0.22)", border: dragging ? "2px dashed #cc785c" : "2px solid transparent", overflow: "hidden" }}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={(e) => { e.stopPropagation(); setDragging(false) }}
        onDrop={(e) => { e.stopPropagation(); handleDrop(e) }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e8e6e0", background: "#fff" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>🗂️</span>
            <span style={{ fontSize: 15, fontWeight: 600, color: "#1a1a1a" }}>关联代码</span>
            {files.length > 0 && <span style={{ fontSize: 12, color: "#8a8a8a", background: "#f0eee8", borderRadius: 4, padding: "2px 7px" }}>{files.length} 个文件 · {totalLines} 行</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={handleUploadClick}
              disabled={uploading}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: uploading ? "default" : "pointer", fontFamily: "inherit", fontWeight: 500, color: "#1a1a1a", opacity: uploading ? 0.6 : 1 }}
            >{uploading ? "⏳ 读取中…" : "⬆ 上传文件"}</button>
            <button
              onClick={addBlankFile}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: "none", background: "#1a1a1a", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 500, color: "#fff" }}
            >＋ 粘贴代码</button>
            <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: "#8a8a8a", lineHeight: 1, padding: "0 4px" }}>×</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
          {/* Left: file list */}
          <div style={{ width: 200, borderRight: "1px solid #e8e6e0", background: "#fff", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
              {files.length === 0 ? (
                <div style={{ padding: "24px 16px", textAlign: "center", color: "#aaa", fontSize: 12, lineHeight: 1.6 }}>
                  上传文件或<br />点击「粘贴代码」
                </div>
              ) : files.map((f, i) => (
                <div
                  key={i}
                  onClick={() => { setSelectedIdx(i); setEditingName(false) }}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", cursor: "pointer", background: i === selectedIdx ? "#f4f3ef" : "transparent", borderLeft: i === selectedIdx ? "3px solid #1a1a1a" : "3px solid transparent" }}
                >
                  <span style={{ fontSize: 10, fontWeight: 700, color: getColor(f.filename), background: getColor(f.filename) + "18", borderRadius: 3, padding: "1px 4px", flexShrink: 0, textTransform: "uppercase" }}>
                    {f.filename.split(".").pop()?.slice(0, 4) ?? "txt"}
                  </span>
                  <span style={{ fontSize: 12, color: "#1a1a1a", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.filename}>{f.filename}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); removeFile(i) }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#bbb", fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0, opacity: 0, transition: "opacity 0.1s" }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
                  >×</button>
                </div>
              ))}
            </div>
          </div>

          {/* Right: code editor */}
          {selected ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {/* File name bar */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #e8e6e0", background: "#faf9f6" }}>
                {editingName ? (
                  <input
                    autoFocus
                    value={selected.filename}
                    onChange={(e) => updateFilename(e.target.value)}
                    onBlur={() => setEditingName(false)}
                    onKeyDown={(e) => { if (e.key === "Enter") setEditingName(false) }}
                    style={{ flex: 1, border: "1px solid #cc785c", borderRadius: 6, padding: "4px 8px", fontSize: 13, fontFamily: "monospace", outline: "none", background: "#fff" }}
                  />
                ) : (
                  <span
                    onClick={() => setEditingName(true)}
                    title="点击重命名"
                    style={{ fontSize: 13, fontFamily: "monospace", color: "#1a1a1a", cursor: "text", padding: "4px 0", borderBottom: "1px dashed #ccc" }}
                  >{selected.filename}</span>
                )}
                <span style={{ fontSize: 11, color: "#aaa", marginLeft: "auto" }}>{selected.content.split("\n").length} 行</span>
              </div>
              {/* Code area with line numbers */}
              <div style={{ flex: 1, display: "flex", overflow: "hidden", fontFamily: "monospace", fontSize: 12 }}>
                {/* Line numbers */}
                <div style={{ padding: "12px 8px 12px 12px", background: "#f4f3ef", color: "#bbb", textAlign: "right", userSelect: "none", lineHeight: "20px", overflowY: "hidden", minWidth: 40, fontSize: 11 }}
                  aria-hidden>
                  {selected.content.split("\n").map((_, i) => (
                    <div key={i}>{i + 1}</div>
                  ))}
                </div>
                {/* Editable textarea */}
                <textarea
                  value={selected.content}
                  onChange={(e) => updateContent(e.target.value)}
                  placeholder="在这里粘贴或编辑代码…"
                  spellCheck={false}
                  style={{ flex: 1, padding: "12px", border: "none", outline: "none", resize: "none", fontFamily: "monospace", fontSize: 12, lineHeight: "20px", background: "#fff", color: "#1a1a1a", overflowY: "auto" }}
                />
              </div>
            </div>
          ) : (
            /* Empty drop zone */
            <div
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "#aaa" }}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDrop={handleDrop}
            >
              <span style={{ fontSize: 40 }}>⬆</span>
              <p style={{ margin: 0, fontSize: 14, color: "#888", textAlign: "center", lineHeight: 1.6 }}>将代码文件拖拽到此处<br /><span style={{ fontSize: 12 }}>或点击右上角「上传文件」</span></p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderTop: "1px solid #e8e6e0", background: "#fff" }}>
          <span style={{ fontSize: 12, color: "#aaa" }}>支持 .ts .tsx .js .jsx .css .py .vue .html 等</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>取消</button>
            <button
              onClick={() => onConfirm(files.filter((f) => f.content.trim()))}
              disabled={files.filter((f) => f.content.trim()).length === 0}
              style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: files.some((f) => f.content.trim()) ? "#1a1a1a" : "#ccc", color: "#fff", fontSize: 13, cursor: files.some((f) => f.content.trim()) ? "pointer" : "default", fontFamily: "inherit", fontWeight: 500 }}
            >确认关联 {files.filter((f) => f.content.trim()).length > 0 ? `(${files.filter((f) => f.content.trim()).length} 个文件)` : ""}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// LinkModal — enter a design reference URL
// ─────────────────────────────────────────────────────────
function LinkModal({ open, url, onUrlChange, onConfirm, onClose }: {
  open: boolean; url: string
  onUrlChange: (v: string) => void
  onConfirm: () => void; onClose: () => void
}) {
  if (!open) return null
  const isValid = (() => { try { return !!new URL(url) } catch { return false } })()
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: "#fff", borderRadius: 14, padding: 24, width: 480,
        display: "flex", flexDirection: "column", gap: 14,
        boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>🔗 通过链接关联设计图</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#8a8a8a", lineHeight: 1 }}>×</button>
        </div>
        <p style={{ margin: 0, fontSize: 13, color: "#6a6a6a" }}>输入 Figma、Sketch、设计图或参考页面的链接，模型将把它作为视觉参考。</p>
        <input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder="https://www.figma.com/…  或其他参考链接"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter" && isValid) onConfirm() }}
          style={{
            border: `1px solid ${isValid || !url ? "#e0ded8" : "#e8a0a0"}`, borderRadius: 8,
            padding: "10px 12px", fontSize: 13, fontFamily: "inherit", outline: "none",
          }}
        />
        {url && !isValid && <p style={{ margin: 0, fontSize: 12, color: "#c04040" }}>请输入有效的 URL（以 http:// 或 https:// 开头）</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "8px 18px", borderRadius: 8, border: "1px solid #e0ded8", background: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>取消</button>
          <button
            onClick={onConfirm}
            disabled={!isValid}
            style={{ padding: "8px 18px", borderRadius: 8, border: "none", background: isValid ? "#1a1a1a" : "#ccc", color: "#fff", fontSize: 13, cursor: isValid ? "pointer" : "default", fontFamily: "inherit", fontWeight: 500 }}
          >确认关联</button>
        </div>
      </div>
    </div>
  )
}

function getDesignToolLabel(name: string): string {
  return getToolLabel(name, { showToolName: false })
}

function getDesignToolParam(args?: Record<string, unknown>): string {
  if (!args) return ""
  const raw =
    args.path ??
    args.file_path ??
    args.command ??
    args.pattern ??
    args.query ??
    args.name ??
    ""
  if (typeof raw !== "string") return ""
  const value = raw.includes("/") ? raw.split("/").pop() || raw : raw
  return value.length > 42 ? `${value.slice(0, 39)}...` : value
}

function DesignExecutionPanel({ events }: { events?: DesignExecutionEvent[] }) {
  if (!events || events.length === 0) return null

  const skills = events.filter((event) => event.kind === "used_skill" && event.name)
  const calls = events.filter((event) => event.kind === "tool_call")
  const resultsByToolCallId = new Map<string, DesignExecutionEvent>()
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolCallId) {
      resultsByToolCallId.set(event.toolCallId, event)
    }
  }

  return (
    <div style={{
      marginTop: 8,
      maxWidth: "85%",
      border: "1px solid #e2e0da",
      borderRadius: 10,
      background: "#fbfaf7",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderBottom: calls.length > 0 ? "1px solid #ebe9e3" : "none",
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#2f3437" }}>技能执行</span>
        {skills.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {skills.map((skill) => (
              <span key={skill.name} style={{
                padding: "2px 7px",
                borderRadius: 999,
                background: skill.status === "error" ? "#fee2e2" : skill.status === "success" ? "#dcfce7" : "#eff0fb",
                color: skill.status === "error" ? "#991b1b" : skill.status === "success" ? "#166534" : "#3a3a8a",
                border: `1px solid ${skill.status === "error" ? "#fecaca" : skill.status === "success" ? "#bbf7d0" : "#c7c9ef"}`,
                fontSize: 11,
                fontWeight: 600,
              }}>
                {skill.name}{skill.status === "error" ? " 失败" : skill.status === "success" ? " 成功" : " 执行中"}
              </span>
            ))}
          </div>
        )}
      </div>
      {calls.length > 0 && (
        <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
          {calls.map((call) => {
            const key = call.toolCallId || call.id || `${call.name}-${call.timestamp}`
            const result = call.toolCallId ? resultsByToolCallId.get(call.toolCallId) : undefined
            const status = result?.isError || call.status === "error"
              ? "error"
              : result || call.status === "success"
                ? "success"
                : "running"
            const param = getDesignToolParam(call.args)
            return (
              <details key={key} style={{
                border: "1px solid #ebe9e3",
                borderRadius: 8,
                background: "#ffffff",
              }}>
                <summary style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  cursor: "pointer",
                  listStyle: "none",
                }}>
                  <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: status === "success" ? "#16a34a" : status === "error" ? "#dc2626" : "#d0a032",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#343a40", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getDesignToolLabel(call.name || "tool")}{param ? `: ${param}` : ""}
                  </span>
                  <span style={{
                    marginLeft: "auto",
                    padding: "1px 6px",
                    borderRadius: 5,
                    fontSize: 10,
                    fontWeight: 700,
                    color: status === "success" ? "#166534" : status === "error" ? "#991b1b" : "#7c5b12",
                    background: status === "success" ? "#dcfce7" : status === "error" ? "#fee2e2" : "#fef3c7",
                    flexShrink: 0,
                  }}>
                    {status === "success" ? "成功" : status === "error" ? "失败" : "执行中"}
                  </span>
                </summary>
                <div style={{ borderTop: "1px solid #f0eee8", padding: "7px 9px" }}>
                  <pre style={{
                    margin: 0,
                    maxHeight: 150,
                    overflow: "auto",
                    fontSize: 11,
                    lineHeight: 1.45,
                    color: "#4b5563",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}>
                    {result?.content
                      ? result.content.slice(0, 1600)
                      : JSON.stringify(call.args ?? {}, null, 2)}
                  </pre>
                </div>
              </details>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user"
  const isQPrompt = message.role === "questions-prompt"

  if (isQPrompt) {
    return (
      <div style={{ margin: "6px 0 10px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(204,120,92,0.08)", border: "1px solid rgba(204,120,92,0.25)", borderRadius: 20, fontSize: 13, color: "#cc785c", fontWeight: 500 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 10 }}>
      {/* Image thumbnail for screenshot-based messages */}
      {isUser && message.imageUrl && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <img
            src={message.imageUrl}
            style={{ maxHeight: 120, maxWidth: "70%", borderRadius: 10, objectFit: "cover", border: "1px solid #e8e6e0" }}
            alt="截图参考"
          />
        </div>
      )}
      {!isUser && <DesignExecutionPanel events={message.executionEvents} />}
      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
        <div style={{ maxWidth: "85%", padding: "9px 13px", borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: isUser ? "#1a1a1a" : "#f4f3ef", color: isUser ? "#fff" : "#1a1a1a", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {/* File attachment pills — shown at the top of the user bubble */}
          {isUser && message.attachments && message.attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: message.content ? 8 : 0 }}>
              {message.attachments.map((att, i) => (
                <div key={i} style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "3px 9px", borderRadius: 7,
                  background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)",
                  fontSize: 11, color: "rgba(255,255,255,0.92)", fontWeight: 500,
                  maxWidth: 220, overflow: "hidden",
                }}>
                  <span style={{ flexShrink: 0 }}>{att.kind === "code" ? "🗂️" : "📎"}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {att.filename.length > 28 ? att.filename.slice(0, 25) + "…" + att.filename.slice(att.filename.lastIndexOf(".")) : att.filename}
                  </span>
                  {att.meta && (
                    <span style={{ flexShrink: 0, opacity: 0.65, fontSize: 10 }}>{att.meta}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {message.content || (message.isStreaming
            ? <span style={{ opacity: 0.4 }}>{message.isIteration ? "Updating design…" : "Generating…"}</span>
            : "")}
        </div>
      </div>
      {/* Skill pill — shown for user messages that used a skill */}
      {isUser && message.skillName && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 5 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 9px", borderRadius: 999,
            background: "#eff0fb", border: "1px solid #c7c9ef",
            color: "#3a3a8a", fontSize: 11, fontWeight: 600,
          }}>
            <span style={{ fontSize: 12 }}>⚡</span>
            {message.skillName}
          </span>
        </div>
      )}
      {/* Pill tags for user messages after question submission */}
      {isUser && message.tags && message.tags.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {message.tags.map((tag, i) => (
            <span key={i} style={{ padding: "2px 10px", background: "rgba(204,120,92,0.1)", color: "#cc785c", borderRadius: 999, fontSize: 11, fontWeight: 500, border: "1px solid rgba(204,120,92,0.2)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelSelector({ models, selectedId, onChange }: {
  models: ModelOption[]
  selectedId: string | null
  onChange: (id: string) => void
}) {
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <select
        value={selectedId ?? models[0]?.id ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: "none",
          WebkitAppearance: "none",
          background: "#f4f3ef",
          border: "1px solid #e0ded8",
          borderRadius: 8,
          padding: "4px 24px 4px 8px",
          fontSize: 12,
          fontWeight: 500,
          color: "#4a4a4a",
          cursor: "pointer",
          fontFamily: "inherit",
          outline: "none",
          maxWidth: 130,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.name || m.model}</option>
        ))}
      </select>
      {/* chevron icon */}
      <span style={{
        position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
        pointerEvents: "none", fontSize: 9, color: "#8a8a8a",
      }}>▾</span>
    </div>
  )
}

function ToolbarIcon({ children, title, onClick }: { children: React.ReactNode; title?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} title={title} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 15 }}>
      {children}
    </button>
  )
}

function PulsingDot() {
  return <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#cc785c", flexShrink: 0, animation: "pulse 1.2s ease-in-out infinite" }} />
}

// ─────────────────────────────────────────────────────────
// Tweaks toolbar components
// ─────────────────────────────────────────────────────────

function TweaksBtn({ label, icon, active, onClick }: {
  label: string; icon: React.ReactNode; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "5px 10px", height: 30,
        fontSize: 12, fontWeight: 500,
        color: active ? "#1a1a1a" : "#6a6a6a",
        background: active ? "#e8e6e0" : "transparent",
        border: active ? "1px solid #c8c6c0" : "1px solid transparent",
        borderRadius: 7, cursor: "pointer",
        fontFamily: "inherit", transition: "all 0.12s ease",
      }}
    >
      {icon}
      {label}
    </button>
  )
}

function CommentIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5l-3 2V3a1 1 0 0 1 1-1z"
        stroke={active ? "#f59e0b" : "#6a6a6a"} strokeWidth="1.5" fill={active ? "rgba(245,158,11,0.12)" : "none"} strokeLinejoin="round" />
    </svg>
  )
}

function EditIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M11 2l3 3-8 8H3v-3l8-8z"
        stroke={active ? "#3b82f6" : "#6a6a6a"} strokeWidth="1.5" fill={active ? "rgba(59,130,246,0.12)" : "none"} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

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

function CommentPin({ comment, index, pinLeft, pinTop, isActive, onToggle, onSend, onEdit }: {
  comment: CommentItem
  index: number
  pinLeft: number   // computed canvas-left % (accounts for scroll + zoom)
  pinTop: number    // computed canvas-top %
  isActive: boolean
  onToggle: () => void
  onSend: (text: string) => void
  onEdit: (newText: string) => void
}) {
  const AVATAR_SIZE = 26
  const [editText, setEditText] = useState(comment.text)

  // Keep local edit text in sync if parent updates the comment (e.g. after re-open)
  useEffect(() => { setEditText(comment.text) }, [comment.text, isActive])

  const hasEdits = editText.trim() !== comment.text.trim()

  const handleClose = () => {
    if (hasEdits && editText.trim()) onEdit(editText.trim())
    onToggle()
  }

  return (
    <div
      style={{
        position: "absolute",
        left: `${pinLeft}%`,
        top: `${pinTop}%`,
        zIndex: 20,
        transform: "translate(-50%, -50%)",
        pointerEvents: "auto",
      }}
    >
      {/* The pin circle */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        title={comment.text}
        style={{
          width: AVATAR_SIZE, height: AVATAR_SIZE,
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          background: "#f59e0b",
          border: "2px solid #fff",
          boxShadow: isActive
            ? "0 0 0 3px rgba(245,158,11,0.35), 0 4px 12px rgba(0,0,0,0.2)"
            : "0 2px 8px rgba(0,0,0,0.18)",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, padding: 0,
          transition: "box-shadow 0.15s",
        }}
      >
        <span style={{
          transform: "rotate(45deg)",
          fontSize: 11, fontWeight: 700, color: "#fff", lineHeight: 1,
          fontFamily: "inherit",
        }}>
          {index}
        </span>
      </button>

      {/* Expanded popover */}
      {isActive && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: AVATAR_SIZE + 8,
            left: "50%",
            transform: "translateX(-50%)",
            width: 252,
            background: "#ffffff",
            borderRadius: 14,
            boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
            padding: "14px 14px 12px",
            zIndex: 30,
          }}
        >
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span style={{
              width: 20, height: 20, borderRadius: "50%",
              background: "#f59e0b",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, fontWeight: 700, color: "#fff", flexShrink: 0,
            }}>
              {index}
            </span>
            <span style={{ fontSize: 11, color: "#8a8a8a", flex: 1 }}>
              {new Date(comment.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
            </span>
            <button
              onClick={handleClose}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#aaa", padding: "0 2px", lineHeight: 1 }}
            >×</button>
          </div>

          {/* Element tag */}
          <div style={{
            display: "inline-block", marginBottom: 8,
            padding: "2px 8px", borderRadius: 5,
            background: "#fef3c7", color: "#92400e",
            fontSize: 11, fontFamily: "monospace",
            maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {comment.elementDesc}
          </div>

          {/* Editable comment text */}
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                if (editText.trim()) onSend(editText.trim())
              }
              if (e.key === "Escape") { e.preventDefault(); handleClose() }
            }}
            rows={3}
            style={{
              width: "100%", border: "1px solid #e0ded8", borderRadius: 8,
              padding: "7px 9px", fontSize: 13, fontFamily: "inherit",
              resize: "none", outline: "none", lineHeight: 1.5, color: "#1a1a1a",
              boxSizing: "border-box", marginBottom: 10,
              background: "#fafaf8",
            }}
          />

          {/* Actions */}
          <div style={{ display: "flex", gap: 7 }}>
            <button
              onClick={handleClose}
              style={{
                flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
                background: "#f5f4f0", border: "none", borderRadius: 8,
                cursor: "pointer", color: "#6a6a6a", fontFamily: "inherit",
              }}
            >
              {hasEdits ? "保存" : "关闭"}
            </button>
            <button
              onClick={() => { if (editText.trim()) onSend(editText.trim()) }}
              disabled={!editText.trim()}
              style={{
                flex: 2, padding: "6px 0", fontSize: 12, fontWeight: 700,
                background: editText.trim() ? "#cc785c" : "#e0ded8",
                border: "none", borderRadius: 8,
                cursor: editText.trim() ? "pointer" : "default",
                color: editText.trim() ? "#fff" : "#aaa",
                fontFamily: "inherit", transition: "background 0.12s",
              }}
            >
              发送 →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Comment Draft Input — floating text box on new click
// ─────────────────────────────────────────────────────────

function CommentDraftInput({ x, y, elementDesc, onSubmit, onSend, onCancel }: {
  x: number
  y: number
  elementDesc: string
  onSubmit: (text: string) => void   // 保存 — add to pins list
  onSend: (text: string) => void     // 发送 — skip saving, send directly to model
  onCancel: () => void
}) {
  const [text, setText] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { textareaRef.current?.focus() }, [])

  const canSubmit = text.trim().length > 0

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: "translate(-50%, 8px)",
        zIndex: 25,
        width: 264,
        background: "#ffffff",
        borderRadius: 14,
        boxShadow: "0 8px 32px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08)",
        padding: "14px 14px 12px",
      }}
    >
      {/* Draft pin indicator */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{
          width: 20, height: 20, borderRadius: "50%",
          background: "#f59e0b",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, color: "#fff", fontWeight: 700, flexShrink: 0,
        }}>+</span>
        <span style={{ fontSize: 12, color: "#8a8a8a", fontWeight: 500 }}>添加批注</span>
      </div>

      {/* Element context tag */}
      <div style={{
        display: "inline-block", marginBottom: 10,
        padding: "3px 10px", borderRadius: 6,
        background: "#fef3c7", color: "#92400e",
        fontSize: 11, fontFamily: "monospace", fontWeight: 500,
        maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {elementDesc}
      </div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (canSubmit) onSubmit(text.trim()) }
          if (e.key === "Escape") { e.preventDefault(); onCancel() }
        }}
        placeholder="输入批注内容… (Shift+Enter 换行)"
        rows={3}
        style={{
          width: "100%", border: "1px solid #e0ded8", borderRadius: 8,
          padding: "8px 10px", fontSize: 13, fontFamily: "inherit",
          resize: "none", outline: "none", lineHeight: 1.5, color: "#1a1a1a",
          boxSizing: "border-box",
        }}
      />

      {/* 3-button row: 取消 / 保存 / 发送 */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1, padding: "6px 0", fontSize: 12, fontWeight: 500,
            background: "#f5f4f0", border: "none", borderRadius: 8,
            cursor: "pointer", color: "#6a6a6a", fontFamily: "inherit",
          }}
        >
          取消
        </button>
        <button
          onClick={() => { if (canSubmit) onSubmit(text.trim()) }}
          disabled={!canSubmit}
          style={{
            flex: 1.4, padding: "6px 0", fontSize: 12, fontWeight: 600,
            background: canSubmit ? "#f5f4f0" : "#ebebeb",
            border: canSubmit ? "1px solid #c8c6c0" : "1px solid #e0ded8",
            borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#1a1a1a" : "#aaa",
            fontFamily: "inherit", transition: "all 0.12s",
          }}
        >
          保存
        </button>
        <button
          onClick={() => { if (canSubmit) onSend(text.trim()) }}
          disabled={!canSubmit}
          style={{
            flex: 1.6, padding: "6px 0", fontSize: 12, fontWeight: 700,
            background: canSubmit ? "#cc785c" : "#e0ded8",
            border: "none", borderRadius: 8,
            cursor: canSubmit ? "pointer" : "default",
            color: canSubmit ? "#fff" : "#aaa",
            fontFamily: "inherit", transition: "background 0.12s",
          }}
        >
          发送 →
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// DesignGallery — history screen (Claude Design style card grid)
// ─────────────────────────────────────────────────────────

function DesignGallery({
  sessionIndex,
  onOpen,
  onNew,
  onDelete,
}: {
  sessionIndex: SessionMeta[]
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  function fmt(ts: number) {
    const d = new Date(ts)
    const now = new Date()
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
    if (diffDays === 0) return "今天 " + d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    if (diffDays === 1) return "昨天"
    if (diffDays < 7)  return `${diffDays} 天前`
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" })
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      background: "#f0efeb",
    }}>
      {/* Title bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 28px", height: 56, background: "#f0efeb", flexShrink: 0,
        borderBottom: "1px solid #e0ded8",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 30, height: 30, borderRadius: "50%",
            background: "#cc785c",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontSize: 15,
          }}>✦</div>
          <span style={{ fontSize: 17, fontWeight: 600, color: "#1a1a1a" }}>My Designs</span>
          {sessionIndex.length > 0 && (
            <span style={{
              fontSize: 12, color: "#8a8a8a",
              background: "#e8e6e0", borderRadius: 99,
              padding: "2px 8px", fontWeight: 500,
            }}>{sessionIndex.length}</span>
          )}
        </div>
        <button
          onClick={onNew}
          style={{
            display: "flex", alignItems: "center", gap: 7,
            padding: "8px 20px", fontSize: 14, fontWeight: 600,
            background: "#1a1a1a", color: "#fff",
            border: "none", borderRadius: 10, cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          新建设计
        </button>
      </div>

      {/* Card grid */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "32px 28px",
      }}>
        {sessionIndex.length === 0 ? (
          /* Empty state */
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", gap: 20,
            color: "#8a8a8a",
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 20,
              background: "#ffffff", border: "2px dashed #d4d2cc",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, color: "#c0beb8",
            }}>✦</div>
            <div style={{ textAlign: "center" }}>
              <p style={{ fontSize: 16, fontWeight: 600, color: "#4a4a4a", margin: "0 0 6px" }}>还没有设计记录</p>
              <p style={{ fontSize: 13, color: "#8a8a8a", margin: 0 }}>点击「新建设计」开始创作</p>
            </div>
            <button
              onClick={onNew}
              style={{
                padding: "10px 28px", fontSize: 14, fontWeight: 600,
                background: "#cc785c", color: "#fff",
                border: "none", borderRadius: 10, cursor: "pointer",
                fontFamily: "inherit",
              }}
            >新建设计</button>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 18,
          }}>
            {/* "New design" card — always first */}
            <button
              onClick={onNew}
              style={{
                aspectRatio: "4/3",
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center", gap: 10,
                background: "#ffffff", border: "2px dashed #d4d2cc",
                borderRadius: 16, cursor: "pointer", fontFamily: "inherit",
                transition: "border-color 0.15s, box-shadow 0.15s",
                color: "#8a8a8a",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#cc785c"
                e.currentTarget.style.boxShadow = "0 4px 20px rgba(204,120,92,0.12)"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#d4d2cc"
                e.currentTarget.style.boxShadow = "none"
              }}
            >
              <span style={{
                width: 42, height: 42, borderRadius: "50%",
                background: "#f5f4f0", border: "1px solid #d4d2cc",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 22, color: "#8a8a8a",
              }}>+</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>新建设计</span>
            </button>

            {/* Session cards */}
            {[...sessionIndex].sort((a, b) => b.updatedAt - a.updatedAt).map((meta) => (
              <div
                key={meta.id}
                onClick={() => onOpen(meta.id)}
                onMouseEnter={() => setHoveredId(meta.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  aspectRatio: "4/3",
                  position: "relative",
                  background: "#ffffff",
                  borderRadius: 16,
                  border: "1px solid #e8e6e0",
                  cursor: "pointer",
                  overflow: "hidden",
                  boxShadow: hoveredId === meta.id
                    ? "0 8px 32px rgba(0,0,0,0.12)"
                    : "0 1px 4px rgba(0,0,0,0.06)",
                  transition: "box-shadow 0.15s",
                  display: "flex", flexDirection: "column",
                }}
              >
                {/* Preview area (placeholder pattern) */}
                <div style={{
                  flex: 1, background: "#f8f7f4",
                  backgroundImage: "radial-gradient(circle, #d4d2cc 1px, transparent 1px)",
                  backgroundSize: "18px 18px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <span style={{ fontSize: 28, opacity: 0.25 }}>✦</span>
                </div>

                {/* Footer */}
                <div style={{
                  padding: "10px 14px",
                  borderTop: "1px solid #f0eee8",
                  background: "#ffffff",
                }}>
                  <div style={{
                    fontSize: 13, fontWeight: 600, color: "#1a1a1a",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    marginBottom: 3,
                  }} title={meta.title}>
                    {meta.title || "无标题设计"}
                  </div>
                  <div style={{ fontSize: 11, color: "#a0a0a0" }}>
                    {fmt(meta.updatedAt)}
                  </div>
                </div>

                {/* Delete button (hover) */}
                {hoveredId === meta.id && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDeleteId(meta.id)
                    }}
                    title="删除"
                    style={{
                      position: "absolute", top: 10, right: 10,
                      width: 28, height: 28, borderRadius: "50%",
                      background: "rgba(255,255,255,0.92)",
                      border: "1px solid #e0ded8",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      cursor: "pointer", fontSize: 14, color: "#6a6a6a",
                      boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
                    }}
                  >🗑</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete confirmation dialog */}
      {confirmDeleteId && (
        <div
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setConfirmDeleteId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#ffffff", borderRadius: 16,
              padding: "28px 32px", width: 340,
              boxShadow: "0 12px 48px rgba(0,0,0,0.18)",
              fontFamily: "'Inter', -apple-system, sans-serif",
            }}
          >
            <h3 style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 600, color: "#1a1a1a" }}>删除这个设计？</h3>
            <p style={{ margin: "0 0 24px", fontSize: 13, color: "#6a6a6a", lineHeight: 1.6 }}>
              删除后无法恢复。
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                onClick={() => setConfirmDeleteId(null)}
                style={{
                  padding: "8px 20px", fontSize: 13, fontWeight: 500,
                  background: "#f5f4f0", border: "none", borderRadius: 8,
                  cursor: "pointer", fontFamily: "inherit", color: "#4a4a4a",
                }}
              >取消</button>
              <button
                onClick={() => { onDelete(confirmDeleteId); setConfirmDeleteId(null) }}
                style={{
                  padding: "8px 20px", fontSize: 13, fontWeight: 600,
                  background: "#dc2626", color: "#fff",
                  border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit",
                }}
              >删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root:              { display: "flex", flexDirection: "column", height: "100%", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", background: "#f0efeb" },
  titleBar:          { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 48, background: "#f0efeb", flexShrink: 0 },
  logo:              { width: 28, height: 28, borderRadius: "50%", background: "#cc785c", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14 },
  titleText:         { fontSize: 15, fontWeight: 500, color: "#1a1a1a" },
  titleActions:      { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  workspaceBtn:      { display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 240, padding: "6px 10px", fontSize: 12, fontWeight: 600, border: "1px solid #d4d2cc", borderRadius: 8, fontFamily: "inherit", minWidth: 0 },
  workspaceIcon:     { fontSize: 12, lineHeight: 1, color: "inherit", flexShrink: 0 },
  workspaceText:     { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, minWidth: 0 },
  shareBtn:          { padding: "6px 16px", fontSize: 13, fontWeight: 600, background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" },
  mainContent:       { display: "flex", flex: 1, overflow: "hidden" },

  // Left panel
  leftPanel:         { width: 420, flexShrink: 0, display: "flex", flexDirection: "column", background: "#ffffff", borderRight: "1px solid #e8e6e0" },
  tabBar:            { display: "flex", alignItems: "center", padding: "0 8px 0 16px", borderBottom: "1px solid #e8e6e0", height: 44, overflowX: "auto" },
  addTabBtn:         { width: 28, height: 28, border: "none", background: "none", cursor: "pointer", fontSize: 18, color: "#8a8a8a", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4, flexShrink: 0, marginLeft: 4 },
  chatBody:          { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" },
  emptyState:        { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "32px 24px", flex: 1 },
  emptyTitle:        { fontSize: 22, fontWeight: 600, color: "#1a1a1a", margin: "0 0 8px" },
  emptySubtitle:     { fontSize: 14, color: "#8a8a8a", margin: 0 },
  contextCards:      { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 300, marginTop: 24 },
  messageList:       { flex: 1, overflowY: "auto", padding: "16px" },
  inputArea:         { padding: "12px 16px 16px", borderTop: "1px solid #e8e6e0", flexShrink: 0 },
  inputBox:          { border: "1px solid #e0ded8", borderRadius: 12, background: "#fafaf8", padding: "10px 12px" },
  textarea:          { width: "100%", border: "none", background: "transparent", resize: "none", fontSize: 14, color: "#1a1a1a", outline: "none", fontFamily: "inherit", lineHeight: 1.5, boxSizing: "border-box" as const },
  inputToolbar:      { display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  importBtn:         { padding: "4px 10px", fontSize: 12, fontWeight: 500, background: "none", border: "1px solid #d0cec8", borderRadius: 6, cursor: "pointer", color: "#4a4a4a", fontFamily: "inherit" },
  sendBtn:           { padding: "6px 16px", fontSize: 13, fontWeight: 600, color: "#fff", border: "none", borderRadius: 8, fontFamily: "inherit", transition: "background 0.15s" },
  cancelBtn:         { padding: "6px 16px", fontSize: 13, fontWeight: 600, background: "#e8e6e0", color: "#4a4a4a", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "inherit" },
  approvalPrimaryBtn: { padding: "6px 12px", fontSize: 12, fontWeight: 700, background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" },
  approvalSessionBtn: { padding: "6px 12px", fontSize: 12, fontWeight: 600, background: "#2563eb", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" },
  approvalPermanentBtn: { padding: "6px 12px", fontSize: 12, fontWeight: 600, background: "#16a34a", color: "#fff", border: "none", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" },
  approvalRejectBtn: { padding: "6px 12px", fontSize: 12, fontWeight: 600, background: "#ffffff", color: "#4a4a4a", border: "1px solid #d0cec8", borderRadius: 7, cursor: "pointer", fontFamily: "inherit" },

  // Right panel
  rightPanel:        { flex: 1, display: "flex", flexDirection: "column", background: "#f0efeb", overflow: "hidden" },
  canvasBar:         { display: "flex", alignItems: "center", padding: "0 12px", height: 45, background: "#f0efeb", borderBottom: "1px solid #e0ded8", flexShrink: 0, gap: 4 },
  navBtn:            { width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "#ffffff", border: "1px solid #d0cec8", borderRadius: 8, cursor: "pointer", fontSize: 14, color: "#4a4a4a", flexShrink: 0 },
  canvasActionBtn:   { display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", fontSize: 13, fontWeight: 500, background: "none", border: "1px solid #d0cec8", borderRadius: 8, cursor: "pointer", color: "#1a1a1a", fontFamily: "inherit" },
  canvas:            { flex: 1, position: "relative" as const, overflow: "hidden" },
  iframe:            { width: "100%", height: "100%", border: "none" },
  canvasEmpty:       { position: "absolute" as const, inset: 0, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", backgroundImage: "radial-gradient(circle, #c8c6c0 1px, transparent 1px)", backgroundSize: "24px 24px" },
  canvasEmptyText:   { fontSize: 18, color: "#8a8a8a", marginBottom: 20, fontWeight: 400 },
  startSketchBtn:    { display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 20px", fontSize: 14, fontWeight: 500, background: "#ffffff", border: "1px solid #d0cec8", borderRadius: 10, cursor: "pointer", color: "#1a1a1a", fontFamily: "inherit", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" },
  generatingRow:     { display: "flex", alignItems: "center", gap: 10 },

  // Questions panel
  questionsContainer:{ display: "flex", flexDirection: "column" as const, height: "100%", background: "#f5f4f0" },
  questionsInner:    { flex: 1, overflowY: "auto" as const, padding: "40px 48px 24px" },
  questionsTitle:    { fontSize: 26, fontWeight: 600, color: "#1a1a1a", margin: "0 0 32px", lineHeight: 1.2 },
  questionBlock:     { marginBottom: 28 },
  questionLabel:     { display: "block", fontSize: 15, fontWeight: 600, color: "#1a1a1a", marginBottom: 6 },
  questionHint:      { fontSize: 13, color: "#8a8a8a", margin: "0 0 10px" },
  chipsRow:          { display: "flex", flexWrap: "wrap" as const, gap: 8 },
  chip:              { padding: "7px 16px", fontSize: 13, fontWeight: 500, borderRadius: 999, cursor: "pointer", fontFamily: "inherit", transition: "all 0.12s ease", whiteSpace: "nowrap" as const },
  chipOtherInput:    { padding: "6px 14px", fontSize: 13, border: "1px solid #d4d2cc", borderRadius: 999, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", minWidth: 100 },
  questionInput:     { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #d4d2cc", borderRadius: 10, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", boxSizing: "border-box" as const },
  questionTextarea:  { width: "100%", padding: "10px 14px", fontSize: 14, border: "1px solid #d4d2cc", borderRadius: 10, background: "#ffffff", outline: "none", fontFamily: "inherit", color: "#1a1a1a", resize: "vertical" as const, lineHeight: 1.5, boxSizing: "border-box" as const },
  questionsFooter:   { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 48px", borderTop: "1px solid #e0ded8", background: "#f0efeb", flexShrink: 0 },
  continueBtn:       { padding: "10px 28px", fontSize: 14, fontWeight: 600, color: "#ffffff", border: "none", borderRadius: 10, fontFamily: "inherit", transition: "background 0.15s" },

  // Tweaks toolbar
  tweaksBar:         { display: "flex", alignItems: "center", gap: 4 },
  tweaksDivider:     { width: 1, height: 18, background: "#d4d2cc", margin: "0 4px", flexShrink: 0 },
  toggleTrack:       { width: 28, height: 16, borderRadius: 999, border: "none", cursor: "pointer", position: "relative" as const, padding: 0, transition: "background 0.2s", flexShrink: 0 },
  toggleThumb:       { position: "absolute" as const, top: 2, left: 2, width: 12, height: 12, borderRadius: "50%", background: "#ffffff", transition: "transform 0.2s", display: "block" },
  zoomBtn:           { width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid #d4d2cc", borderRadius: 5, cursor: "pointer", fontSize: 13, color: "#4a4a4a", fontFamily: "inherit", lineHeight: 1 },
}
