import type { ParsedAttachment } from "../file-parser"

export const FILE_ATTACHMENT_PARSE_CANCELLED = "FILE_ATTACHMENT_PARSE_CANCELLED"
export const FILE_ATTACHMENT_PARSE_TIMEOUT = "FILE_ATTACHMENT_PARSE_TIMEOUT"
export const FILE_ATTACHMENT_PARSE_TIMEOUT_MS = 15_000
export const FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES = 256 * 1024

export type FileAttachmentParserSource = {
  kind: "bytes"
  fileName: string
  bytes: ArrayBuffer
}

export interface FileAttachmentParserRequest {
  type: "parse"
  requestId: number
  source: FileAttachmentParserSource
  maxLength?: number
  cancellationBuffer: SharedArrayBuffer
}

export interface FileAttachmentParserShutdownRequest {
  type: "shutdown"
}

export type FileAttachmentParserWorkerRequest =
  | FileAttachmentParserRequest
  | FileAttachmentParserShutdownRequest

export interface FileAttachmentParserSuccess {
  type: "parse-result"
  requestId: number
  ok: true
  attachment: ParsedAttachment
}

export interface FileAttachmentParserFailure {
  type: "parse-result"
  requestId: number
  ok: false
  error: { code: string; message: string; stack?: string }
}

export interface FileAttachmentParserShutdownComplete {
  type: "shutdown-complete"
}

export type FileAttachmentParserWorkerResponse =
  | FileAttachmentParserSuccess
  | FileAttachmentParserFailure
  | FileAttachmentParserShutdownComplete
