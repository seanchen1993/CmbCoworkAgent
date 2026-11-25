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

export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024
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
