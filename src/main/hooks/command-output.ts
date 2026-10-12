import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function detectHookOutputEncoding(buf: Buffer): string {
  if (buf.length === 0) return "utf-8"
  const detected = chardet.detect(buf)
  if (!detected) return "utf-8"

  const encoding = typeof detected === "string" ? detected : detected.encoding
  const confidence = typeof detected === "object" ? detected.confidence : 1

  if (!encoding || encoding.toLowerCase() === "ascii" || !iconv.encodingExists(encoding)) {
    return "utf-8"
  }

  if (confidence >= CHARDET_CONFIDENCE_THRESHOLD) {
    return encoding
  }

  // On Chinese Windows, short GBK/GB18030 output often comes back with low confidence
  // even though the bytes are definitely not UTF-8. In that case, trust the detector.
  if (!isValidUtf8(buf)) {
    return encoding
  }

  return "utf-8"
}

export function decodeHookOutput(
  stdoutBuf: Buffer,
  stderrBuf: Buffer
): { stdout: string; stderr: string } {
  if (process.platform !== "win32") {
    return {
      stdout: stdoutBuf.length > 0 ? stdoutBuf.toString("utf-8") : "",
      stderr: stderrBuf.length > 0 ? stderrBuf.toString("utf-8") : ""
    }
  }
  // Sample both streams in bounded chunks so stderr-only Chinese diagnostics still
  // influence detection when stdout contains ASCII / JSON.
  const perStreamSampleBytes = Math.floor(CHARDET_SAMPLE_BYTES / 2)
  const sample = Buffer.concat([
    stdoutBuf.subarray(0, perStreamSampleBytes),
    stderrBuf.subarray(0, CHARDET_SAMPLE_BYTES - perStreamSampleBytes)
  ])
  const encoding = detectHookOutputEncoding(sample)
  try {
    return {
      stdout: stdoutBuf.length > 0 ? iconv.decode(stdoutBuf, encoding) : "",
      stderr: stderrBuf.length > 0 ? iconv.decode(stderrBuf, encoding) : ""
    }
  } catch {
    return {
      stdout: stdoutBuf.toString("utf-8"),
      stderr: stderrBuf.toString("utf-8")
    }
  }
}
