export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENT_PICKER_FILES = 3
export const MAX_ATTACHMENT_FILE_NAME_LENGTH = 512
export const MAX_REQUIREMENT_BACKGROUND_FILE_BYTES = 10 * 1024 * 1024
export const MAX_REQUIREMENT_BACKGROUND_FILES = 10
export const MAX_REQUIREMENT_BACKGROUND_URLS = 10
export const REQUIREMENT_BACKGROUND_FILE_ACCEPT =
  ".docx,.md,.txt,.html,.htm,.avif,.bmp,.gif,.heic,.heif,.jpg,.jpeg,.png,.svg,.webp"

export function isSupportedRequirementBackgroundFileName(fileName: string): boolean {
  return /\.(?:docx|md|txt|html?|avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)$/i.test(fileName.trim())
}

export interface SelectedAttachmentFileGrant {
  filePath: string
  grant: string
}

export interface AttachmentFileSelectionResult {
  canceled: boolean
  files: SelectedAttachmentFileGrant[]
  error?: string
}

export interface AttachmentGrantParseRequest {
  grant: string
  filePath: string
  maxLength?: number
}

export interface AttachmentBytesParseRequest {
  fileName: string
  bytes: ArrayBuffer
  maxLength?: number
}

/** Text extraction plus the retained original file's identity. */
export interface FileAttachment {
  /** Bot picker receipt; ordinary attachments and message text cannot mint this identity. */
  botInputId?: string
  /** A linked ordinary draft retained the extracted text without an original file version. */
  originalUnavailable?: true
  filename: string
  filePath: string
  content: string
  mimeType: string
  size: number
  truncated: boolean
}
