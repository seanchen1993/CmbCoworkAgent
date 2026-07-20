import type { GoalEvaluationInput } from "./evaluator"
import type { GoalJudgeDecision } from "./types"

export const DEFAULT_GOAL_EVALUATOR_RUNTIME_ATTEMPTS = 3
export const DEFAULT_GOAL_EVALUATOR_RUNTIME_RETRY_DELAY_MS = 750
const GOAL_EVALUATOR_FAILURE_REASON = "评估器暂时不可用。请稍后使用 /goal resume 重试。"
const GOAL_EVALUATOR_FAILURE_DETAIL_MAX_CHARS = 360
const GOAL_EVALUATOR_ERROR_JSON_MAX_DEPTH = 3
const GOAL_EVALUATOR_ERROR_JSON_MAX_ENTRIES = 24
const GOAL_EVALUATOR_ERROR_JSON_STRING_MAX_CHARS = 1_000

type GoalEvaluatorRuntime = (
  input: GoalEvaluationInput,
  options: { modelId?: string; abortSignal?: AbortSignal }
) => Promise<GoalJudgeDecision>

export interface GoalEvaluatorRuntimeRetryOptions {
  evaluate: GoalEvaluatorRuntime
  modelId?: string
  abortSignal?: AbortSignal
  attempts?: number
  retryDelayMs?: number
  isAbortLikeError?: (error: unknown) => boolean
  onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void
  onFinalFailure?: (error: unknown) => GoalJudgeDecision
}

function createAbortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" })
}

function replaceAsciiControlCharacters(message: string): string {
  let sanitized = ""
  for (const char of message) {
    const code = char.charCodeAt(0)
    sanitized += (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ? " " : char
  }
  return sanitized
}

function redactPotentialSecrets(message: string): string {
  return message
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----"
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/?#\s:@]+:[^/?#\s@]+@/gi, "$1[redacted]@")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]")
    .replace(
      /(["']?)(authorization)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|(?:[A-Za-z][A-Za-z0-9._~-]*\s+)?[^"',;\s}\]]+)/gi,
      "$2=[redacted]"
    )
    .replace(
      /(["']?)(cookie|set-cookie|session[_-]?id|session|signature|sig|credential|security[_-]?token|access[_-]?token)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^"',;\s}\]]+)/gi,
      "$2=[redacted]"
    )
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|private[_-]?key)[A-Za-z0-9_-]*|key)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^"',;\s}\]]+)/gi,
      "$2=[redacted]"
    )
    .replace(
      /\b(api\s*key|secret|token|password)\s+(?:is\s+|was\s+|[:=]\s*)?["']?[A-Za-z0-9._~+/=-]{12,}/gi,
      "$1 [redacted]"
    )
    .replace(
      /([?&](?:x-amz-)?(?:credential|security-token|signature|sig)=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[redacted]")
}

function truncateErrorString(value: string): string {
  if (value.length <= GOAL_EVALUATOR_ERROR_JSON_STRING_MAX_CHARS) return value
  return `${value.slice(0, GOAL_EVALUATOR_ERROR_JSON_STRING_MAX_CHARS - 1)}…`
}

function toBoundedJsonValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return truncateErrorString(value)
  if (typeof value === "symbol") return String(value)
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]"
  if (typeof value !== "object") return String(value)

  if (seen.has(value)) return "[Circular]"
  if (depth >= GOAL_EVALUATOR_ERROR_JSON_MAX_DEPTH) {
    const name = value.constructor?.name
    return name ? `[${name}]` : "[object]"
  }

  seen.add(value)
  if (Array.isArray(value)) {
    const items = value
      .slice(0, GOAL_EVALUATOR_ERROR_JSON_MAX_ENTRIES)
      .map((item) => toBoundedJsonValue(item, depth + 1, seen))
    if (value.length > GOAL_EVALUATOR_ERROR_JSON_MAX_ENTRIES) items.push("…")
    seen.delete(value)
    return items
  }

  const output: Record<string, unknown> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries.slice(0, GOAL_EVALUATOR_ERROR_JSON_MAX_ENTRIES)) {
    output[key] = toBoundedJsonValue(item, depth + 1, seen)
  }
  if (entries.length > GOAL_EVALUATOR_ERROR_JSON_MAX_ENTRIES) output["…"] = "…"
  seen.delete(value)
  return output
}

function stringifyUnknownError(error: unknown): string {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (typeof error === "symbol") return String(error)
  if (typeof error === "function") return error.name ? `[function ${error.name}]` : "[function]"

  try {
    const json = JSON.stringify(toBoundedJsonValue(error, 0, new WeakSet<object>()))
    if (typeof json === "string") return json
  } catch {
    // Fall back below; formatter must never throw while building a pause reason.
  }

  try {
    return String(error)
  } catch {
    return ""
  }
}

function normalizeErrorSummary(error: unknown): string {
  const raw =
    error instanceof Error
      ? [error.name && error.name !== "Error" ? error.name : "", error.message]
          .filter(Boolean)
          .join(": ")
      : stringifyUnknownError(error)

  const summary = replaceAsciiControlCharacters(redactPotentialSecrets(raw))
    .replace(/\s+/g, " ")
    .trim()

  if (summary.length <= GOAL_EVALUATOR_FAILURE_DETAIL_MAX_CHARS) return summary
  return `${summary.slice(0, GOAL_EVALUATOR_FAILURE_DETAIL_MAX_CHARS - 1)}…`
}

export function formatGoalEvaluatorRuntimeFailureReason(error: unknown): string {
  const summary = normalizeErrorSummary(error)
  if (!summary) return GOAL_EVALUATOR_FAILURE_REASON
  return `评估器暂时不可用：${summary}。请稍后使用 /goal resume 重试。`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createAbortError()
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (delayMs <= 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  throwIfAborted(signal)
}

export async function evaluateGoalWithRuntimeRetry(
  input: GoalEvaluationInput,
  options: GoalEvaluatorRuntimeRetryOptions
): Promise<GoalJudgeDecision> {
  const maxAttempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_GOAL_EVALUATOR_RUNTIME_ATTEMPTS)
  )
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_GOAL_EVALUATOR_RUNTIME_RETRY_DELAY_MS
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      throwIfAborted(options.abortSignal)
      return await options.evaluate(input, {
        modelId: options.modelId,
        abortSignal: options.abortSignal
      })
    } catch (error) {
      if (options.abortSignal?.aborted || options.isAbortLikeError?.(error)) throw error
      lastError = error
      if (attempt < maxAttempts) {
        options.onRetry?.(error, attempt, maxAttempts)
        await waitForRetry(retryDelayMs, options.abortSignal)
      }
    }
  }

  if (options.onFinalFailure) return options.onFinalFailure(lastError)
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
