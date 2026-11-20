import * as chardet from "jschardet"
import * as iconv from "iconv-lite"

const CHARDET_SAMPLE_BYTES = 4_096

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function detectHookOutputEncoding(buf: Buffer): string {
  // Validate the complete stream before sampling: a sample can end halfway
  // through a UTF-8 character, and detector confidence is only a heuristic.
  // The runner already bounds the combined output to 1 MB.
  if (buf.length === 0 || isValidUtf8(buf)) return "utf-8"
  const detected = chardet.detect(buf.subarray(0, CHARDET_SAMPLE_BYTES))
  if (!detected) return "utf-8"

  const encoding = typeof detected === "string" ? detected : detected.encoding

  if (!encoding || encoding.toLowerCase() === "ascii" || !iconv.encodingExists(encoding)) {
    return "utf-8"
  }

  // On Chinese Windows, short GBK/GB18030 output often comes back with low confidence
  // even though the bytes are definitely not UTF-8. Retain that legacy fallback.
  return encoding
}

function decodeHookStream(buf: Buffer, platform: NodeJS.Platform): string {
  if (buf.length === 0) return ""
  if (platform !== "win32") return buf.toString("utf-8")
  try {
    return iconv.decode(buf, detectHookOutputEncoding(buf))
  } catch {
    return buf.toString("utf-8")
  }
}

export function decodeHookOutput(
  stdoutBuf: Buffer,
  stderrBuf: Buffer,
  platform: NodeJS.Platform = process.platform
): { stdout: string; stderr: string } {
  // Child processes may use different encodings for protocol output and diagnostics.
  return {
    stdout: decodeHookStream(stdoutBuf, platform),
    stderr: decodeHookStream(stderrBuf, platform)
  }
}
