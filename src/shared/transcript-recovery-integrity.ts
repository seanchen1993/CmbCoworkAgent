/** These bounds must match durable transcript normalization and page hydration. */
const DEPTH_LIMIT = 6
const ARRAY_LIMIT = 100
const KEY_LIMIT = 80

function isLosslessJson(value: unknown, stringLimit: number, depth = 0): boolean {
  if (typeof value === "string") return value.length <= stringLimit
  if (value === null || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || depth >= DEPTH_LIMIT) return false
  if (Array.isArray(value)) {
    if (value.length > ARRAY_LIMIT) return false
    for (let index = 0; index < value.length; index += 1) {
      if (!isLosslessJson(value[index], stringLimit, depth + 1)) return false
    }
    return true
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  let keys = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    keys += 1
    if (
      key === "__proto__" ||
      keys > KEY_LIMIT ||
      !isLosslessJson(value[key], stringLimit, depth + 1)
    )
      return false
  }
  return true
}

/** Constant-time for ordinary streamed text; structured traversal stops at storage bounds. */
export function isLosslessTranscriptPayload(content: unknown, toolCalls?: unknown): boolean {
  if (typeof content === "string") {
    if (content.length > 120_000) return false
  } else {
    if (!Array.isArray(content) || content.length > 80) return false
    if (!content.every((block) => isLosslessJson(block, 60_000))) return false
  }
  if (toolCalls === undefined || toolCalls === null) return true
  return (
    Array.isArray(toolCalls) &&
    toolCalls.length <= 50 &&
    toolCalls.every((call) => isLosslessJson(call, 20_000))
  )
}

export type TranscriptRecoveryIntegrity = "verified" | "unverified"

/** A later preview, alias merge, or timing-only update cannot certify an older row. */
export function mergeTranscriptRecoveryIntegrity(
  ...values: Array<TranscriptRecoveryIntegrity | undefined>
): TranscriptRecoveryIntegrity {
  return values.every((value) => value === "verified") ? "verified" : "unverified"
}

export function decodeTranscriptRecoveryIntegrity(value: unknown): TranscriptRecoveryIntegrity {
  return value === 1 ? "verified" : "unverified"
}
