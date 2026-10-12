/** Only explicit provider quota signals override ordinary HTTP 429 backoff.
 * MiniMax 2056: https://platform.minimax.io/docs/api-reference/errorcode
 * This module is also used by the renderer; no transport or credentials live here. */
export const MODEL_QUOTA_ERROR_INFO = {
  category: "quota_exceeded" as const,
  label: "模型额度已用尽",
  hint: "请恢复额度或更换模型后重试"
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function quotaFields(value: unknown): boolean {
  if (own(value, "code") === "insufficient_quota") return true
  const base = own(value, "base_resp")
  if (own(base, "status_code") === 2056) return true
  const message = own(value, "message")
  // The compatible SDK puts MiniMax's numeric code in the message. A bare
  // number or a generic rate-limit error is insufficient evidence of quota.
  return (
    typeof message === "string" &&
    /\(2056\)/.test(message) &&
    /Token Plan/i.test(message) &&
    /用量上限|usage limit (?:reached|exceeded)/i.test(message)
  )
}

export function isModelQuotaResponse(status: number, rawBody: string | undefined): boolean {
  if (status !== 429 || !rawBody || rawBody.length > 16 * 1024) return false
  try {
    const parsed: unknown = JSON.parse(rawBody)
    return quotaFields(parsed) || quotaFields(own(parsed, "error"))
  } catch {
    return false
  }
}

/** Classifiers also receive arbitrary tool values. Require a thrown Error and
 * an explicit HTTP status; never infer quota from quoted prose or a number. */
export function isModelQuotaError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  while (current instanceof Error && !seen.has(current) && seen.size < 64) {
    seen.add(current)
    const status = own(current, "status") ?? own(own(current, "response"), "status")
    if (status === 429 && (quotaFields(current) || quotaFields(own(current, "error")))) return true
    current = own(current, "cause")
  }
  return false
}
