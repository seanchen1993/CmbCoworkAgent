export const WORKSPACE_FILE_PREVIEW_CANCELLED = "WORKSPACE_FILE_PREVIEW_CANCELLED"

// A preview page must stay cheap to clone over IPC and cheap to project in React.
// Files above either budget are explicitly paged instead of being read/split whole.
export const WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES = 64 * 1024
export const WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES = 500
export const WORKSPACE_FILE_PREVIEW_RENDERER_CACHE_BYTES = 2 * 1024 * 1024
export const WORKSPACE_FILE_PREVIEW_MAX_LANE_LENGTH = 160
export const WORKSPACE_FILE_PREVIEW_MAX_TOKEN_LENGTH = 160

export const WORKSPACE_FILE_PREVIEW_ERROR_CODES = {
  CANCELLED: "cancelled",
  NOT_FOUND: "not-found",
  FILESYSTEM_PERMISSION_DENIED: "filesystem-permission-denied",
  SOURCE_AUTHORIZATION_MISSING: "source-authorization-missing",
  SOURCE_AUTHORIZATION_INVALID: "source-authorization-invalid",
  SOURCE_OUTSIDE_TRUSTED_ROOT: "source-outside-trusted-root",
  WORKSPACE_UNAVAILABLE: "workspace-unavailable",
  NOT_REGULAR_FILE: "not-regular-file",
  FILE_CHANGED: "file-changed",
  INVALID_REQUEST: "invalid-request",
  CAPACITY_EXCEEDED: "capacity-exceeded",
  UNKNOWN: "unknown"
} as const

export type WorkspaceFilePreviewErrorCode =
  (typeof WORKSPACE_FILE_PREVIEW_ERROR_CODES)[keyof typeof WORKSPACE_FILE_PREVIEW_ERROR_CODES]

/**
 * Workspace previews normally use a path relative to the thread's authoritative
 * workspace. `auto` is reserved for a known file-index source whose slash-prefixed
 * candidate remains ambiguous while renderer metadata hydrates; ordinary tool
 * arguments must retain their OS absolute/relative semantics.
 */
export type WorkspaceFilePreviewWorkspacePathKind = "relative" | "absolute" | "auto"

export type WorkspaceFilePreviewSource =
  | {
      threadId: string
      filePath: string
      workspacePathKind?: WorkspaceFilePreviewWorkspacePathKind
      externalGrant?: never
    }
  | {
      externalGrant: string
      filePath: string
      threadId?: never
      workspacePathKind?: never
    }

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

export interface ToolFilePreviewGrantRequest {
  threadId: string
  toolCallId: string
}

export type ToolFilePreviewGrantResult =
  | {
      success: true
      external: false
      filePath: string
    }
  | {
      success: true
      external: true
      filePath: string
      grant: string
      expiresAt: number
    }
  | {
      success: false
      error: string
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
  errorCode?: WorkspaceFilePreviewErrorCode
  cancelled?: boolean
}

export type WorkspaceFilePreviewReadResult =
  | WorkspaceFilePreviewTextResult
  | WorkspaceFilePreviewFailure

export type WorkspaceFilePreviewOpenMediaResult =
  | WorkspaceFilePreviewMediaResult
  | WorkspaceFilePreviewFailure
