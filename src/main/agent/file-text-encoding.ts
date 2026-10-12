import * as chardet from "jschardet"
import * as iconv from "iconv-lite"

/** Shared unchanged decoding policy extracted from Cmb LocalSandbox. */
export const CMB_KNOWN_BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".mp3",
  ".mp4",
  ".wav",
  ".mov",
  ".avi",
  ".mkv",
  ".zip",
  ".gz",
  ".tar",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pyc",
  ".class",
  ".o",
  ".obj",
  ".sqlite",
  ".db",
  ".pdf",
  ".doc",
  ".xls",
  ".ppt",
  ".docx",
  ".xlsx",
  ".pptx"
])

/**
 * Detect file encoding from raw buffer (inspired by Cline's detectEncoding,
 * but extended for read+write: Cline only uses it for reading, while we also
 * use the detected encoding to write back, so we upgrade ASCII → UTF-8 to
 * avoid replacing non-ASCII chars with '?').
 * 0. Fast reject known binary extensions before any I/O-heavy detection
 * 1. Check for binary via null/control-byte sampling before accepting text guesses
 * 2. Try jschardet — if it returns a valid encoding, use it (ASCII → utf-8)
 * 3. Fallback to utf-8 for plain text
 */
export function detectCmbFileEncoding(buffer: Buffer, ext?: string): string {
  if (ext && CMB_KNOWN_BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`Cannot read binary file type: ${ext}`)
  }

  const detected = chardet.detect(buffer)
  const detectedEncoding =
    detected && detected.encoding && iconv.encodingExists(detected.encoding)
      ? detected.encoding
      : null
  if (hasBinaryControlBytes(buffer) && !isKnownTextEncodingWithNullBytes(detectedEncoding)) {
    throw new Error(`Cannot read text for file type: ${ext || "unknown"}`)
  }

  if (detectedEncoding) {
    // ASCII is a strict subset of UTF-8; upgrade so non-ASCII chars
    // written by the agent (e.g. CJK) are not replaced with '?'.
    if (detectedEncoding.toLowerCase() === "ascii") return "utf-8"
    return detectedEncoding
  }

  return "utf-8"
}

function hasBinaryControlBytes(buffer: Buffer): boolean {
  const sampleLen = buffer.length
  if (sampleLen === 0) return false

  let nonPrintableCount = 0
  for (let i = 0; i < sampleLen; i++) {
    const byte = buffer[i]
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) {
      nonPrintableCount++
    }
  }
  return nonPrintableCount / sampleLen > 0.3
}

function isKnownTextEncodingWithNullBytes(encoding: string | null): boolean {
  if (!encoding) return false
  const normalized = encoding.toLowerCase().replace(/[-_\s]/g, "")
  return normalized.startsWith("utf16") || normalized.startsWith("utf32")
}
