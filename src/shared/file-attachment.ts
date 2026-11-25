export const attachmentMimeTypes: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".xml": "application/xml",
  ".log": "text/plain",
  ".tsv": "text/tab-separated-values"
}

export const attachmentExtensions = Object.keys(attachmentMimeTypes)
export const attachmentFormatLabel = attachmentExtensions.map(ext => ext.slice(1)).join("、")

export const chatImageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
export function isChatImagePath(filePath: string): boolean {
  const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? ""
  return chatImageExtensions.includes(filename.slice(filename.lastIndexOf(".")).toLowerCase())
}

export interface WorkspaceChatImageRequest {
  threadId: string
  workspacePath: string
  filePath: string
}

export type ChatImageOwnerRequest = {
  threadId: string
  workspacePath: string | null
  incarnation?: string
} & (
  | { action: "pin"; messageId: string; ids: string[]; previousMessageId?: string }
  | { action: "unpin"; messageId: string }
  | { action: "discard"; ids: string[] }
)

export interface ChatImageStatusRequest {
  threadId: string
  workspacePath: string | null
  incarnation: string
  messageId: string
}

export type ChatImageSubmissionStatus =
  | "missing" | "pending" | "unknown" | "accepted" | "running" | "succeeded" | "failed" | "rejected"
export const chatUploadExtensions = [...attachmentExtensions, ...chatImageExtensions]
export const chatUploadLabel = chatUploadExtensions.map(ext => ext.slice(1)).join("、")

export interface SubmittedChatImage {
  id: string
  filename: string
  slot: number
}

export interface ChatImageRef {
  draftWorkspace?: string
  id: string
  filename: string
  width: number
  height: number
}

export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024
export const MAX_ATTACHMENT_TOTAL_CHARS = 24_000
export const MAX_ATTACHMENT_PICKER_FILES = 3
export const MAX_ATTACHMENT_FILE_NAME_LENGTH = 512

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
  threadId?: string
  workspacePath?: string | null
  grant: string
  filePath: string
  maxLength?: number
}

export interface AttachmentBytesParseRequest {
  threadId?: string
  workspacePath?: string | null
  fileName: string
  bytes: ArrayBuffer
  maxLength?: number
}

/** Text extraction plus the retained original file's identity. */
export interface FileAttachment {
  image?: ChatImageRef
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

/** A pure visual turn already has a payload; the UI must preserve the user's empty text. */
export function attachmentFallbackText(files: readonly FileAttachment[]): string {
  const hasDocument = files.some(file => !file.image &&
    !(file.botInputId && ["image/png", "image/jpeg", "image/webp"].includes(file.mimeType)))
  return hasDocument ? "请分析以下文件内容。" : ""
}
