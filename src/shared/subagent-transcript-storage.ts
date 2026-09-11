// Every inline field is repeated inside the thread_values JSON row. Keeping the
// old 24 KiB activity-preview size here made a 10k-message transcript approach
// hundreds of MiB even though the complete values already lived in sidecars.
export const SUBAGENT_TRANSCRIPT_INLINE_BYTES = 512
export const SUBAGENT_TRANSCRIPT_DESCRIPTION_BYTES = 1_024
export const SUBAGENT_TRANSCRIPT_STARTUP_FIELD_BYTES = 512
export const SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES = 2_000_000
/** Maximum recent execution buckets included in task-switch startup hydration. */
export const SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT = 200
export const MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS = 24_000
export const SUBAGENT_TRANSCRIPTS_THREAD_VALUE_KEY = "subagentTranscripts"

/** Stable UTF-16 fingerprint shared by live registration and persisted migration. */
export function fingerprintSubagentTranscriptContent(content: string): string {
  let hash = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${content.length}:${hash >>> 0}`
}

export function buildSubagentFinalSignature(input: {
  isError: boolean
  status?: string
  contentFingerprint: string
  reasoningFingerprint: string
}): string {
  return JSON.stringify([
    input.isError ? "error" : "success",
    input.status ?? "",
    input.contentFingerprint,
    input.reasoningFingerprint
  ])
}

export type SubagentTranscriptBlobKind = "content" | "reasoning" | "tool_calls"

export interface SubagentTranscriptBlobRef {
  v: 1
  sha256: string
  bytes: number
  kind: SubagentTranscriptBlobKind
}

export function getSubagentTranscriptBlobReferenceHashKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const record = value as Record<string, unknown>
  return (["content", "reasoning", "tool_calls"] as const)
    .flatMap((field) => {
      const ref = record[`${field}_ref`]
      return isSubagentTranscriptBlobRef(ref, field) ? [ref.sha256] : []
    })
    .sort()
    .join("\n")
}

export function projectSubagentTranscriptBoundaries(
  fullLength: number,
  availableHead: string,
  availableTail: string
): string {
  if (fullLength <= MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS) {
    return availableHead.slice(0, fullLength)
  }

  let marker = ""
  let head = 0
  let tail = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const contentBudget = MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS - marker.length
    head = Math.floor(contentBudget * 0.7)
    tail = contentBudget - head
    const nextMarker = `\n…[省略 ${fullLength - head - tail} 字]…\n`
    if (nextMarker === marker) break
    marker = nextMarker
  }

  const contentBudget = MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS - marker.length
  head = Math.floor(contentBudget * 0.7)
  tail = contentBudget - head
  marker = `\n…[省略 ${fullLength - head - tail} 字]…\n`
  if (head + tail + marker.length > MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS) {
    tail = Math.max(0, MAX_SUBAGENT_TRANSCRIPT_PREVIEW_CHARS - head - marker.length)
  }
  return `${availableHead.slice(0, head)}${marker}${availableTail.slice(-tail)}`
}

export function projectSubagentTranscriptContent(content: string): string {
  return projectSubagentTranscriptBoundaries(content.length, content, content)
}

function serializedUtf8Bytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function projectJsonStringToUtf8Bytes(content: string, byteLimit: number): string {
  if (serializedUtf8Bytes(content) <= byteLimit) return content
  let low = 0
  let high = Math.min(content.length, byteLimit)
  let best = ""
  while (low <= high) {
    const retainedCodeUnits = Math.floor((low + high) / 2)
    let headLength = Math.floor(retainedCodeUnits * 0.7)
    let tailLength = retainedCodeUnits - headLength
    if (
      headLength > 0 &&
      headLength < content.length &&
      /[\uD800-\uDBFF]/.test(content[headLength - 1])
    ) {
      headLength -= 1
    }
    const tailStart = content.length - tailLength
    if (
      tailLength > 0 &&
      tailStart > 0 &&
      /[\uDC00-\uDFFF]/.test(content[tailStart])
    ) {
      tailLength -= 1
    }
    const omitted = Math.max(0, content.length - headLength - tailLength)
    const candidate = `${content.slice(0, headLength)}\n…[省略 ${omitted} 字]…\n${
      tailLength > 0 ? content.slice(-tailLength) : ""
    }`
    if (serializedUtf8Bytes(candidate) <= byteLimit) {
      best = candidate
      low = retainedCodeUnits + 1
    } else {
      high = retainedCodeUnits - 1
    }
  }
  return best
}

/** A persistence preview whose JSON representation is strictly byte-bounded. */
export function projectSubagentTranscriptContentForStorage(content: string): string {
  return projectJsonStringToUtf8Bytes(content, SUBAGENT_TRANSCRIPT_INLINE_BYTES)
}

/** Keep card metadata small; the exact task prompt remains in `content`. */
export function projectSubagentDescription(content: string): string {
  return projectJsonStringToUtf8Bytes(content, SUBAGENT_TRANSCRIPT_DESCRIPTION_BYTES)
}

export function projectSubagentTranscriptStartupContent(content: string): string {
  return projectJsonStringToUtf8Bytes(content, SUBAGENT_TRANSCRIPT_STARTUP_FIELD_BYTES)
}

export function isSubagentTranscriptBlobRef(
  value: unknown,
  expectedKind?: SubagentTranscriptBlobKind
): value is SubagentTranscriptBlobRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<SubagentTranscriptBlobRef>
  return (
    candidate.v === 1 &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256) &&
    typeof candidate.bytes === "number" &&
    Number.isSafeInteger(candidate.bytes) &&
    candidate.bytes >= 0 &&
    (candidate.kind === "content" ||
      candidate.kind === "reasoning" ||
      candidate.kind === "tool_calls") &&
    (!expectedKind || candidate.kind === expectedKind)
  )
}
