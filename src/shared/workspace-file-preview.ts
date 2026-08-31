export const WORKSPACE_FILE_PREVIEW_CANCELLED = "WORKSPACE_FILE_PREVIEW_CANCELLED"

// A preview page must stay cheap to clone over IPC and cheap to project in React.
// Files above either budget are explicitly paged instead of being read/split whole.
export const WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES = 64 * 1024
export const WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES = 500
export const WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES = 2 * 1024 * 1024
export const WORKSPACE_FILE_PREVIEW_MAX_LANE_LENGTH = 160
export const WORKSPACE_FILE_PREVIEW_MAX_TOKEN_LENGTH = 160

export type WorkspaceFilePreviewSource =
  | { threadId: string; filePath: string; externalGrant?: never }
  | { externalGrant: string; filePath: string; threadId?: never }

export interface WorkspaceFilePreviewRequestBase {
  source: WorkspaceFilePreviewSource
  lane: string
  requestToken: string
}

export interface WorkspaceFilePreviewReadRequest extends WorkspaceFilePreviewRequestBase {
  offset?: number
}

export interface WorkspaceFilePreviewOpenMediaRequest extends WorkspaceFilePreviewRequestBase {
  mimeType?: string
}

export interface WorkspaceFilePreviewCancelRequest {
  lanePrefix: string
  requestToken: string
}

export interface WorkspaceFilePreviewReleaseRequest {
  previewUrl: string
}

export interface WorkspaceFilePreviewTextResult {
  success: true
  content: string
  contentBytes: number
  size: number
  modified_at: string
  offset: number
  nextOffset: number | null
  hasMore: boolean
  hasPrevious: boolean
  truncated: boolean
  lineCount: number
}

export interface WorkspaceFilePreviewMediaResult {
  success: true
  previewUrl: string | null
  inlineAllowed: boolean
  inlineBlockedReason?: string
  size: number
  modified_at: string
  mimeType: string
}

export interface WorkspaceFilePreviewFailure {
  success: false
  error: string
  cancelled?: boolean
}

export type WorkspaceFilePreviewReadResult =
  | WorkspaceFilePreviewTextResult
  | WorkspaceFilePreviewFailure

export type WorkspaceFilePreviewOpenMediaResult =
  | WorkspaceFilePreviewMediaResult
  | WorkspaceFilePreviewFailure
