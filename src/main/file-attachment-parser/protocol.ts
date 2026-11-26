import type { ParsedDocument } from "../file-parser"
import { MAX_ATTACHMENT_FILE_BYTES, MAX_CHAT_IMAGES } from "../../shared/file-attachment"

export const FILE_ATTACHMENT_PARSE_CANCELLED = "FILE_ATTACHMENT_PARSE_CANCELLED"
export const FILE_ATTACHMENT_PARSE_TIMEOUT = "FILE_ATTACHMENT_PARSE_TIMEOUT"
export const FILE_ATTACHMENT_PARSE_TIMEOUT_MS = 15_000
export const FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES = 256 * 1024

export function isBoundedParseResponse(attachment: ParsedDocument): boolean {
  const { documentImages = [], ...metadata } = attachment
  return attachment.content.length <= 32_000 &&
    Buffer.byteLength(JSON.stringify(metadata), "utf8") <= FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES &&
    documentImages.length <= MAX_CHAT_IMAGES &&
    documentImages.every(image => image.bytes instanceof ArrayBuffer) &&
    documentImages.reduce((total, image) => total + image.bytes.byteLength, 0) <= MAX_ATTACHMENT_FILE_BYTES
}

export type FileAttachmentParserSource = {
  kind: "bytes"
  fileName: string
  bytes: ArrayBuffer
  allowHtmlSource?: true
}

export interface FileAttachmentParserRequest {
  type: "parse"
  requestId: number
  source: FileAttachmentParserSource
  maxLength?: number
  includeImageBytes?: boolean
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
  attachment: ParsedDocument
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
