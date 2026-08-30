/**
 * File parser module – extracts text content from various file formats.
 *
 * Supported formats:
 *   .txt / .csv  – read with auto-detected encoding (GBK, Shift_JIS, UTF-8, etc.)
 *   .docx        – extract via mammoth → markdown
 *   .xlsx / .xls – extract via xlsx → CSV text
 */

import * as fs from "fs/promises"
import * as path from "path"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"

/** Parsed result returned to the renderer. */
export interface ParsedAttachment {
  filename: string
  filePath: string    // full path for display
  content: string     // extracted text
  mimeType: string
  /** Original file size in bytes */
  size: number
  /** true when content was truncated */
  truncated: boolean
}

/** Max text length (characters) to inject into context. ~24k chars ≈ ~6-7k tokens */
const MAX_TEXT_LENGTH = 24_000

/** Max file size in bytes (5 MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024

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
function truncateContent(content: string, isLineBased: boolean, maxLen: number = MAX_TEXT_LENGTH): { content: string; truncated: boolean } {
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

/**
 * Parse a file and extract its text content.
 * Throws on unsupported format or read failure.
 */
export async function parseFile(filePath: string, maxLength?: number): Promise<ParsedAttachment> {
  const resolved = path.resolve(filePath)
  const ext = path.extname(resolved).toLowerCase()
  const filename = path.basename(resolved)
  // Security: reject symlinks to prevent reading sensitive files via symlink
  const lstat = await fs.lstat(resolved)
  if (lstat.isSymbolicLink()) {
    throw new Error("不支持符号链接文件")
  }
  if (!lstat.isFile()) {
    throw new Error("只能解析普通文件")
  }

  if (lstat.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大（${(lstat.size / 1024 / 1024).toFixed(1)}MB），单文件不超过 5MB`)
  }

  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`不支持的文件类型: ${ext}，仅支持 txt、md、csv、docx、xlsx、xls`)
  }

  let content: string
  let mimeType: string
  let isLineBased = false

  switch (ext) {
    case ".txt":
    case ".md": {
      content = await readTextFileAutoEncoding(resolved)
      mimeType = ext === ".md" ? "text/markdown" : "text/plain"
      break
    }
    case ".csv": {
      content = await readTextFileAutoEncoding(resolved)
      mimeType = "text/csv"
      isLineBased = true
      break
    }
    case ".docx": {
      content = await parseDocx(resolved)
      mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      break
    }
    case ".xlsx":
    case ".xls": {
      content = await parseExcel(resolved)
      mimeType = ext === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.ms-excel"
      isLineBased = true
      break
    }
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }

  const limit = maxLength !== undefined ? Math.min(maxLength, MAX_TEXT_LENGTH) : MAX_TEXT_LENGTH
  const { content: finalContent, truncated } = truncateContent(content, isLineBased, limit)

  return { filename, filePath: resolved, content: finalContent, mimeType, size: lstat.size, truncated }
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

async function readTextFileAutoEncoding(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath)
  const encoding = detectEncoding(buffer)
  return iconv.decode(buffer, encoding)
}

// ---------------------------------------------------------------------------
// Format-specific parsers
// ---------------------------------------------------------------------------

async function parseDocx(filePath: string): Promise<string> {
  const mammoth = await import("mammoth")
  const buffer = await fs.readFile(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

async function parseExcel(filePath: string): Promise<string> {
  const XLSX = await import("xlsx")
  const buffer = await fs.readFile(filePath)
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
