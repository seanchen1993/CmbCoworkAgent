/**
 * File parser module – extracts text content from various file formats.
 *
 * Supported formats:
 *   .txt / .csv  – read with auto-detected encoding (GBK, Shift_JIS, UTF-8, etc.)
 *   .docx        – extract via mammoth → markdown
 *   .xlsx / .xls – extract via xlsx → CSV text
 */

import * as path from "path"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import AdmZip from "adm-zip"
import {
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILE_NAME_LENGTH
} from "../shared/file-attachment"

export { MAX_ATTACHMENT_FILE_BYTES } from "../shared/file-attachment"

/** Parsed result returned to the renderer. */
export interface ParsedAttachment {
  filename: string
  filePath: string // full picker path or dropped-file display identity
  content: string // extracted text
  mimeType: string
  /** Original file size in bytes */
  size: number
  /** true when content was truncated */
  truncated: boolean
}

/** Max text length (characters) to inject into context. ~24k chars ≈ ~6-7k tokens */
export const MAX_ATTACHMENT_TEXT_LENGTH = 24_000
export const MAX_ATTACHMENT_ARCHIVE_ENTRIES = 4_096
export const MAX_ATTACHMENT_ARCHIVE_ENTRY_BYTES = 32 * 1024 * 1024
export const MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".csv", ".docx", ".xlsx", ".xls"])

export function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return SUPPORTED_EXTENSIONS.has(ext)
}

export function getSupportedExtensions(): string[] {
  return [...SUPPORTED_EXTENSIONS]
}

/**
 * Truncate text content to MAX_TEXT_LENGTH with a clear summary of what was lost.
 * For line-based content (csv, xlsx), truncates at line boundaries.
 */
function truncateContent(
  content: string,
  isLineBased: boolean,
  maxLen: number = MAX_ATTACHMENT_TEXT_LENGTH
): { content: string; truncated: boolean } {
  if (content.length <= maxLen) {
    return { content, truncated: false }
  }

  const totalChars = content.length
  const lines = content.split("\n")
  const totalLines = lines.length

  if (isLineBased) {
    // Truncate at line boundary to avoid cutting a row in half
    let charCount = 0
    let keepLines = 0
    for (const line of lines) {
      if (charCount + line.length + 1 > maxLen) break
      charCount += line.length + 1
      keepLines++
    }
    const kept = lines.slice(0, keepLines).join("\n")
    const droppedLines = totalLines - keepLines
    return {
      content: kept + `\n\n... [内容已截取：显示前 ${keepLines} 行（共 ${totalLines} 行），省略了 ${droppedLines} 行、${(totalChars - kept.length).toLocaleString()} 个字符]`,
      truncated: true
    }
  }

  // For prose (txt, docx): truncate at last paragraph/sentence boundary
  const sliced = content.slice(0, maxLen)
  const lastParagraph = sliced.lastIndexOf("\n\n")
  const lastNewline = sliced.lastIndexOf("\n")
  const cutPoint = lastParagraph > maxLen * 0.8
    ? lastParagraph
    : lastNewline > maxLen * 0.8
      ? lastNewline
      : maxLen
  const kept = content.slice(0, cutPoint)
  const droppedChars = totalChars - kept.length

  return {
    content: kept + `\n\n... [内容已截取：显示前 ${kept.length.toLocaleString()} 个字符（共 ${totalChars.toLocaleString()} 个字符），省略了 ${droppedChars.toLocaleString()} 个字符]`,
    truncated: true
  }
}

/** Parse bytes obtained from a browser File selected by an explicit drop gesture. */
export async function parseFileBytes(
  fileName: string,
  bytes: ArrayBuffer,
  maxLength?: number
): Promise<ParsedAttachment> {
  if (
    typeof fileName !== "string" ||
    !fileName ||
    fileName.length > MAX_ATTACHMENT_FILE_NAME_LENGTH ||
    fileName.includes("\0")
  ) {
    throw new Error("无效的附件文件名")
  }
  if (!(bytes instanceof ArrayBuffer)) throw new Error("无效的附件内容")
  const filename = path.basename(fileName)
  return parseAttachmentBuffer(Buffer.from(bytes), filename, filename, maxLength)
}

async function parseAttachmentBuffer(
  buffer: Buffer,
  filename: string,
  filePath: string,
  maxLength?: number
): Promise<ParsedAttachment> {
  if (
    maxLength !== undefined &&
    (!Number.isSafeInteger(maxLength) || maxLength <= 0)
  ) {
    throw new Error("附件字符预算无效")
  }
  if (buffer.byteLength > MAX_ATTACHMENT_FILE_BYTES) {
    throw new Error(
      `文件过大（${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB），单文件不超过 5MB`
    )
  }
  const ext = path.extname(filename).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的文件类型: ${ext}，仅支持 txt、md、csv、docx、xlsx、xls`)
  }
  if (ext === ".docx" || ext === ".xlsx") assertBoundedOfficeArchive(buffer)

  let content: string
  let mimeType: string
  let isLineBased = false

  switch (ext) {
    case ".txt":
    case ".md": {
      content = decodeTextFileAutoEncoding(buffer)
      mimeType = ext === ".md" ? "text/markdown" : "text/plain"
      break
    }
    case ".csv": {
      content = decodeTextFileAutoEncoding(buffer)
      mimeType = "text/csv"
      isLineBased = true
      break
    }
    case ".docx": {
      content = await parseDocx(buffer)
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      break
    }
    case ".xlsx":
    case ".xls": {
      content = await parseExcel(buffer)
      mimeType = ext === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.ms-excel"
      isLineBased = true
      break
    }
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }

  const limit =
    maxLength !== undefined
      ? Math.min(maxLength, MAX_ATTACHMENT_TEXT_LENGTH)
      : MAX_ATTACHMENT_TEXT_LENGTH
  const { content: finalContent, truncated } = truncateContent(content, isLineBased, limit)

  return {
    filename,
    filePath,
    content: finalContent,
    mimeType,
    size: buffer.byteLength,
    truncated
  }
}

function assertBoundedOfficeArchive(buffer: Buffer): void {
  let entries: ReturnType<AdmZip["getEntries"]>
  try {
    entries = new AdmZip(buffer).getEntries()
  } catch {
    throw new Error("Office 附件不是有效的 ZIP 文档")
  }
  if (entries.length === 0 || entries.length > MAX_ATTACHMENT_ARCHIVE_ENTRIES) {
    throw new Error(`Office 附件条目数超过 ${MAX_ATTACHMENT_ARCHIVE_ENTRIES} 个上限`)
  }
  let totalBytes = 0
  for (const entry of entries) {
    const entryBytes = Number(entry.header.size)
    if (!Number.isSafeInteger(entryBytes) || entryBytes < 0) {
      throw new Error("Office 附件包含无效条目")
    }
    if (entryBytes > MAX_ATTACHMENT_ARCHIVE_ENTRY_BYTES) {
      throw new Error("Office 附件单个解压条目超过 32MB 上限")
    }
    totalBytes += entryBytes
    if (totalBytes > MAX_ATTACHMENT_ARCHIVE_TOTAL_BYTES) {
      throw new Error("Office 附件解压总量超过 64MB 上限")
    }
  }
}

// ---------------------------------------------------------------------------
// Encoding detection (reuses jschardet + iconv-lite from local-sandbox)
// ---------------------------------------------------------------------------

/** Sample first 8KB for encoding detection (sufficient for accuracy, avoids scanning entire file) */
const ENCODING_SAMPLE_SIZE = 8192

function detectEncoding(buffer: Buffer): string {
  const sample = buffer.length > ENCODING_SAMPLE_SIZE ? buffer.subarray(0, ENCODING_SAMPLE_SIZE) : buffer
  const detected = chardet.detect(sample)
  if (detected && detected.encoding && iconv.encodingExists(detected.encoding)) {
    if (detected.encoding.toLowerCase() === "ascii") return "utf-8"
    return detected.encoding
  }
  return "utf-8"
}

function decodeTextFileAutoEncoding(buffer: Buffer): string {
  const encoding = detectEncoding(buffer)
  return iconv.decode(buffer, encoding)
}

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

async function parseDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth")
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

async function parseExcel(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx")
  const workbook = XLSX.read(buffer, { type: "buffer" })

  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    if (csv.trim()) {
      parts.push(`## Sheet: ${sheetName}\n${csv}`)
    }
  }

  return parts.join("\n\n")
}
