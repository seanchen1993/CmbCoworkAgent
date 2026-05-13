import type { FileAttachment as BaseFileAttachment } from "@/types"

export type FileAttachment = BaseFileAttachment

export interface ChatTab {
  id: string
  label: string
}

export const SINGLE_DESIGN_TAB_ID = "design-main"
export const SINGLE_DESIGN_TAB_LABEL = "Design"

export interface MessageAttachment {
  filename: string
  kind: "code" | "doc"
  meta?: string
}

export interface Message {
  role: "user" | "assistant" | "questions-prompt"
  content: string
  tags?: string[]
  skillName?: string
  attachments?: MessageAttachment[]
  isStreaming?: boolean
  isIteration?: boolean
  imageUrl?: string
  executionEvents?: DesignExecutionEvent[]
  modelRetry?: DesignModelRetryState | null
}

export interface QuestionDef {
  id: string
  type: "text" | "textarea" | "chips"
  label: string
  hint?: string
  options?: string[]
  multi?: boolean
}

export type RightPanelTab = "design" | "questions"
export type GenerationState = "idle" | "asking" | "questions_ready" | "generating" | "done" | "error"
export type DesignSessionKind = "prompt" | "import_url" | "import_html"
export type AnswerValue = string | string[]

export interface VariationItem {
  id: string
  label: string
  html: string
}

export interface CommentItem {
  id: string
  pageX: number
  pageY: number
  text: string
  elementDesc: string
  createdAt: number
}

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawStroke {
  id: string
  points: DrawPoint[]
  color: string
  width: number
  createdAt: number
}

export interface DrawElementHint {
  strokeId: string
  elements: string[]
}

export type DrawToolMode = "draw" | "note"

export interface DrawNote {
  id: string
  pageX: number
  pageY: number
  text: string
  elements: string[]
  createdAt: number
}

export interface DraftDrawNote {
  pageX: number
  pageY: number
  elements: string[]
}

export interface ElementStyles {
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

export interface ModelOption {
  id: string
  name: string
  model: string
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  content?: string
}

export interface DesignSkillReference {
  name: string
  path: string
}

export interface FloatingPanelPosition {
  x: number
  y: number
}

export interface DesignSourceInfo {
  kind: Exclude<DesignSessionKind, "prompt">
  label: string
  detail?: string
}

export interface DesignContextSyncResult {
  attachmentsDir?: string
  attachmentFiles?: Array<{ sourcePath: string; targetPath: string; filename: string }>
  codeDir?: string
  codeFiles?: Array<{ sourcePath: string; targetPath: string; filename: string }>
}

export type DesignApprovalDecision = "approve" | "approve_session" | "approve_permanent" | "reject"
export type DesignExecutionStatus = "running" | "success" | "error"

export interface DesignModelRetryState {
  attempt: number
  maxRetries: number
  reason: string
  delayMs: number
}

export interface DesignExecutionEvent {
  kind: "tool_call" | "tool_result" | "used_skill" | "assistant_text" | "validation"
  id?: string
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  content?: string
  isError?: boolean
  status?: DesignExecutionStatus
  timestamp: number
}

export interface DesignApprovalRequest {
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

export interface TabState {
  messages: Message[]
  html: string
  sourceInfo: DesignSourceInfo | null
  generationState: GenerationState
  questions: QuestionDef[]
  answers: Record<string, AnswerValue>
  originalPrompt: string
  rightTab: RightPanelTab
  variations: VariationItem[]
  activeVariationId: string | null
  selectedModelId: string | null
  tweaksOn: boolean
  activeMode: "comment" | "edit" | "draw" | null
  zoom: number
  inputValue: string
  comments: CommentItem[]
  draftComment: { pageX: number; pageY: number; elementDesc: string } | null
  activeCommentId: string | null
  drawStrokes: DrawStroke[]
  drawElementHints: DrawElementHint[]
  drawNotes: DrawNote[]
  draftDrawNote: DraftDrawNote | null
  drawToolMode: DrawToolMode
  iframeScrollX: number
  iframeScrollY: number
  editModeAvailable: boolean
  selectedElement: { edId: string; tagName: string; styles: ElementStyles } | null
  attachedImage: { base64: string; mimeType: string; previewUrl: string } | null
  reloadKey: number
  selectedSkill: SkillInfo | null
  codeContext: Array<{ filename: string; content: string }> | null
  designLink: string | null
  attachedFiles: FileAttachment[] | null
  retryPrompt: string | null
  retryIsIteration: boolean
  retryCleanMsg: string | null
  retrySkill: DesignSkillReference | null
  artifactPath: string | null
  variationPanelPosition: FloatingPanelPosition | null
  apiHistory: Array<{ role: "user" | "assistant"; content: string }>
  pendingApproval: DesignApprovalRequest | null
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  kind?: DesignSessionKind
  sourceLabel?: string
}
