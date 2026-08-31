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
  type: "text" | "textarea" | "chips" | "direction-cards"
  label: string
  hint?: string
  options?: string[]
  optionLabels?: Record<string, string>
  cards?: DirectionCard[]
  multi?: boolean
  required?: boolean
  maxSelections?: number
  placeholder?: string
}

export type RightPanelTab = "design" | "questions"
export type GenerationState =
  | "idle"
  | "asking"
  | "questions_ready"
  | "generating"
  | "done"
  | "error"
export type DesignSessionKind = "prompt" | "import_url" | "import_html" | "prototype_zip"
export type AnswerValue = string | string[]

/**
 * Payload passed from the standalone new-design page to the editor.
 * Keep this transport shape small so the legacy create dialog can be restored
 * without changing the editor's session model.
 */
export interface DesignCreationRequest {
  kind: DesignSessionKind
  workspacePath: string | null
  title: string
  templateMode?: "select" | "upload" | "none"
  template?: string
  templateUploadPath?: string
  requirementMode?: "select" | "upload" | "none"
  requirementId?: string
  requirementModuleId?: string
  requirementUploadPath?: string
  prompt: string
  url?: string
  designSystemId?: string | null
}

export interface VariationItem {
  id: string
  label: string
  html: string
}

export interface DesignElementAnchor {
  selector: string
  tagName: string
  label?: string
  role?: string
  text?: string
  screenLabel?: string
  offsetXRatio: number
  offsetYRatio: number
}

export interface AnchoredDrawPoint {
  xRatio: number
  yRatio: number
}

export interface CommentItem {
  id: string
  pageX: number
  pageY: number
  text: string
  elementDesc: string
  anchor?: DesignElementAnchor
  createdAt: number
}

export interface DrawPoint {
  x: number
  y: number
}

export interface DrawStroke {
  id: string
  points: DrawPoint[]
  anchor?: DesignElementAnchor
  anchoredPoints?: AnchoredDrawPoint[]
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
  anchor?: DesignElementAnchor
  text: string
  elements: string[]
  createdAt: number
  /** Stroke this note explains, when the note landed on/near one. Undefined = standalone note. */
  strokeId?: string
}

export interface DraftDrawNote {
  pageX: number
  pageY: number
  anchor?: DesignElementAnchor
  elements: string[]
  strokeId?: string
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
  available?: boolean
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  content?: string
  source?: "skill" | "template"
  mode?: string
  platform?: string | null
  scenario?: string
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

export interface DesignSystemInfo {
  id: string
  name: string
  description: string
  category?: string
  source?: string
  origin?: string
  license?: string
  path: string
  tokens?: {
    bg: string
    surface: string
    fg: string
    muted: string
    border: string
    accent: string
  }
}

export interface DirectionCard {
  id: string
  label: string
  mood: string
  references: string[]
  palette: string[]
  displayFont: string
  bodyFont: string
}

export interface DesignArtifactMetadata {
  artifactId: string
  title?: string
  prompt?: string
  modelId?: string | null
  skillName?: string | null
  skillPath?: string | null
  designSystemId?: string | null
  designSystemName?: string | null
  designSystemCategory?: string | null
  sourceKind?: DesignSessionKind
  sourceLabel?: string
  htmlPath?: string
  createdAt: string
  updatedAt: string
  variations?: Array<{ id: string; label: string }>
  preview?: {
    thumbnailText?: string
    thumbnailHtml?: string
  }
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
  draftComment: {
    pageX: number
    pageY: number
    elementDesc: string
    anchor?: DesignElementAnchor
  } | null
  activeCommentId: string | null
  drawStrokes: DrawStroke[]
  drawElementHints: DrawElementHint[]
  drawNotes: DrawNote[]
  draftDrawNote: DraftDrawNote | null
  drawToolMode: DrawToolMode
  iframeScrollX: number
  iframeScrollY: number
  iframeContentWidth: number
  iframeContentHeight: number
  editModeAvailable: boolean
  selectedElement: { edId: string; tagName: string; styles: ElementStyles } | null
  attachedImage: { base64: string; mimeType: string; previewUrl: string } | null
  reloadKey: number
  selectedSkill: SkillInfo | null
  selectedDesignSystemId: string | null
  codeContext: Array<{ filename: string; content: string }> | null
  designLink: string | null
  attachedFiles: FileAttachment[] | null
  retryPrompt: string | null
  retryIsIteration: boolean
  retryCleanMsg: string | null
  retrySkill: DesignSkillReference | null
  artifactPath: string | null
  artifactMetadata: DesignArtifactMetadata | null
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
  thumbnailText?: string
  designSystemId?: string | null
  designSystemName?: string | null
  designSystemCategory?: string | null
  artifactPath?: string | null
}
