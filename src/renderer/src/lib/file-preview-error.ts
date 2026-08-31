import {
  WORKSPACE_FILE_PREVIEW_ERROR_CODES,
  type WorkspaceFilePreviewErrorCode
} from "../../../shared/workspace-file-preview"

export interface FilePreviewErrorState {
  message: string
  code?: WorkspaceFilePreviewErrorCode
}

export interface FriendlyFilePreviewError {
  title: string
  description: string
  detail?: string
  missingPath?: string
}

const knownErrorCodes = new Set<string>(Object.values(WORKSPACE_FILE_PREVIEW_ERROR_CODES))

function isWorkspaceFilePreviewErrorCode(value: unknown): value is WorkspaceFilePreviewErrorCode {
  return typeof value === "string" && knownErrorCodes.has(value)
}

function inferLegacyErrorCode(message: string): WorkspaceFilePreviewErrorCode {
  if (/invalid or expired grant|grant expired|no trusted source grant|missing or invalid grant/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_INVALID
  }
  if (
    /access denied:|outside workspace|outside (?:the )?trusted|path is protected|not issued by the trusted/i.test(
      message
    )
  ) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_OUTSIDE_TRUSTED_ROOT
  }
  if (/enoent|no such file or directory/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_FOUND
  }
  if (/permission denied|eacces|eperm/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILESYSTEM_PERMISSION_DENIED
  }
  if (/no workspace folder linked/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.WORKSPACE_UNAVAILABLE
  }
  if (/cannot preview a directory|not a regular file/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_REGULAR_FILE
  }
  if (/file changed|file moved/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILE_CHANGED
  }
  if (/capacity exceeded/i.test(message)) {
    return WORKSPACE_FILE_PREVIEW_ERROR_CODES.CAPACITY_EXCEEDED
  }
  return WORKSPACE_FILE_PREVIEW_ERROR_CODES.UNKNOWN
}

export function normalizeFilePreviewError(error: unknown): FilePreviewErrorState {
  if (error instanceof Error) {
    const candidate = (error as Error & { code?: unknown }).code
    return {
      message: error.message,
      code:
        isWorkspaceFilePreviewErrorCode(candidate)
          ? candidate
          : inferLegacyErrorCode(error.message)
    }
  }
  const message = String(error)
  return { message, code: inferLegacyErrorCode(message) }
}

export function formatFilePreviewError(
  error: FilePreviewErrorState
): FriendlyFilePreviewError {
  const message = error.message.trim()
  const code = error.code ?? inferLegacyErrorCode(message)
  const missingPath = message.match(/'([^']+)'/)?.[1]

  switch (code) {
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_FOUND:
      return {
        title: "文件不存在或已被移动",
        description: "预览文件失败，当前路径下未找到该文件。",
        detail: "请刷新文件列表，确认文件仍在原位置后重试。",
        missingPath
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILESYSTEM_PERMISSION_DENIED:
      return {
        title: "系统拒绝读取文件",
        description: "操作系统未允许当前进程读取该文件。",
        detail: "请检查 Windows 文件权限、文件占用状态或安全软件拦截后重试。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_AUTHORIZATION_INVALID:
      return {
        title: "文件预览授权已失效",
        description: "外部文件的临时访问授权不存在或已经过期。",
        detail: "请从文件、技能或产物列表中重新打开该文件。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.SOURCE_OUTSIDE_TRUSTED_ROOT:
      return {
        title: "文件不在允许的访问范围",
        description: "应用已阻止读取工作区之外或受保护位置的文件。",
        detail: "请从可信文件入口重新选择，或将文件移动到当前工作区后重试。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.WORKSPACE_UNAVAILABLE:
      return {
        title: "工作区信息尚未就绪",
        description: "当前会话未关联工作区，或工作区信息仍在恢复中。",
        detail: "请确认会话工作区后重试。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.NOT_REGULAR_FILE:
      return {
        title: "无法预览此路径",
        description: "当前路径不是可预览的普通文件。",
        detail: "请选择具体文件，而不是目录或特殊文件。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.FILE_CHANGED:
      return {
        title: "文件已发生变化",
        description: "读取期间文件被移动、替换或修改，预览已安全终止。",
        detail: "请刷新文件列表后重新打开。"
      }
    case WORKSPACE_FILE_PREVIEW_ERROR_CODES.CAPACITY_EXCEEDED:
      return {
        title: "文件预览暂时繁忙",
        description: "同时进行的文件预览请求较多。",
        detail: "请稍后重试；切换文件产生的旧请求会自动取消。"
      }
    default:
      return {
        title: "文件加载失败",
        description: "预览时发生异常，请稍后重试。",
        detail: message
      }
  }
}
