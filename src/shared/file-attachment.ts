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
