import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import * as path from "node:path"

const CHARDET_CONFIDENCE_THRESHOLD = 0.6

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export function decodeSkillTextFile(content: Buffer, filePath: string): string {
  if (content.length === 0) return ""

  // UTF BOM 明确优先，避免误判。
  if (content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf) {
    return content.toString("utf-8")
  }
  if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
    return iconv.decode(content, "utf-16le")
  }
  if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
    return iconv.decode(content, "utf-16be")
  }

  const detected = chardet.detect(content)
  const detectedEncoding = typeof detected === "string" ? detected : detected?.encoding
  const confidence = typeof detected === "object" ? detected.confidence || 0 : 1
  const normalizedEncoding = String(detectedEncoding || "")
    .trim()
    .toLowerCase()

  if (isValidUtf8(content)) {
    return content.toString("utf-8")
  }

  if (
    normalizedEncoding &&
    normalizedEncoding !== "ascii" &&
    iconv.encodingExists(normalizedEncoding)
  ) {
    if (confidence >= CHARDET_CONFIDENCE_THRESHOLD || process.platform !== "win32") {
      try {
        return iconv.decode(content, normalizedEncoding)
      } catch {
        // fallback below
      }
    }
  }

  // Windows 下 CSV 常见 ANSI(GBK/GB18030)；当 UTF-8 无效时优先做兼容回退。
  if (process.platform === "win32" && path.extname(filePath).toLowerCase() === ".csv") {
    try {
      return iconv.decode(content, "gb18030")
    } catch {
      // fallback below
    }
  }

  if (
    normalizedEncoding &&
    normalizedEncoding !== "ascii" &&
    iconv.encodingExists(normalizedEncoding)
  ) {
    try {
      return iconv.decode(content, normalizedEncoding)
    } catch {
      // fallback below
    }
  }

  return content.toString("utf-8")
}
