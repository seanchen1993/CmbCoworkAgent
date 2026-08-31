import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  WORKSPACE_FILE_PREVIEW_ERROR_CODES,
  type WorkspaceFilePreviewErrorCode,
  type WorkspaceFilePreviewFailure
} from "../../shared/workspace-file-preview"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nativeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return ""
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" && code ? code : error.name
}

export function classifyWorkspaceFilePreviewError(
  error: unknown
): WorkspaceFilePreviewErrorCode {
  const code = nativeErrorCode(error).toUpperCase()
  const message = errorMessage(error).toLowerCase()

  if (code === WORKSPACE_FILE_PREVIEW_CANCELLED) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.CANCELLED
  }
  if (code === "ENOENT" || code === "ENOTDIR" || /no such file or directory/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_FOUND
  }
  if (code === "EACCES" || code === "EPERM" || /permission denied/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILESYSTEM_PERMISSION_DENIED
  }
  if (
    /invalid or expired grant|grant expired|missing or invalid grant|sender mismatch|no trusted source grant/.test(
      message
    )
  ) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_INVALID
  }
  if (
    /access denied:|outside workspace|outside (?:the )?trusted|path is protected|not issued by the trusted/.test(
      message
    )
  ) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_OUTSIDE_TRUSTED_ROOT
  }
  if (/no workspace folder linked/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.WORKSPACE_UNAVAILABLE
  }
  if (/cannot preview a directory|not a regular file/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_REGULAR_FILE
  }
  if (/file changed|file moved/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILE_CHANGED
  }
  if (/capacity exceeded/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.CAPACITY_EXCEEDED
  }
  if (/^invalid .*preview/.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.INVALID_REQUEST
  }
  return WORKSPACE_FILE_PREVIEW_ERROR_CODES.UNKNOWN
}

export function workspaceFilePreviewFailure(error: unknown): WorkspaceFilePreviewFailure {
  const errorCode = classifyWorkspaceFilePreviewError(error)
  const cancelled = errorCode === WORKSPACE_FILE_PREVIEW_ERROR_CODES.CANCELLED
  return {
    success: false,
    cancelled,
    errorCode,
    error: cancelled ? "Workspace file preview was cancelled" : errorMessage(error)
  }
}
