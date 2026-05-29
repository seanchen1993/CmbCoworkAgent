/**
 * PR-12 — Unified tool-failure detection for PostToolUseFailure hooks.
 *
 * Tool failures take more shapes than a thrown exception in this runtime:
 *   (a) thrown JS error caught by `toolErrorMiddleware` (runtime.ts:953)
 *   (b) result object with `success: false` / `is_error: true` / non-empty
 *       `error` field
 *   (c) result object with non-zero `exitCode` (playwright / etc.)
 *   (d) plain-string result containing `[Command failed with exit code N]`
 *       — deepagents' `execute` tool joins output with this marker rather
 *       than returning an object (covered by the string branch below)
 *   (e) abort signal fired mid-execution
 *
 * `detectToolFailure` recognises (b)/(c)/(d) shapes from a tool's return
 * value; the throw path is handled directly at the catch site. The
 * `_firedFailureToolCallIds` set deduplicates between the two pathways so a
 * single tool failure never triggers PostToolUseFailure twice for the same
 * `tool_call_id`.
 */

import { classifyApiError, type ApiErrorCode } from "../agent/failover"

export type ToolFailureKind =
  | "throw"
  | "exit-nonzero"
  | "explicit-error"
  | "abort"
  | "timeout"

export interface ToolFailureSignal {
  kind: ToolFailureKind
  message: string
  errorType: ApiErrorCode
  isInterrupt: boolean
  isTimeout: boolean
}

/**
 * Best-effort inspection of a tool result. Returns `null` for "no detectable
 * failure" — caller proceeds with the normal PostToolUse path. The matching
 * is intentionally permissive (covers many ad-hoc shapes) because tools in
 * this codebase have no schema for their return values.
 */
export function detectToolFailure(
  _toolName: string,
  toolResult: unknown
): ToolFailureSignal | null {
  if (toolResult === null || toolResult === undefined) return null

  // PR-12 follow-up — plain-string results. The execute tool (deepagents)
  // and similar shell-style tools join the command's output with a tail
  // line like `[Command failed with exit code 5]`. The original detector
  // only handled object shapes, so every execute non-zero exit slipped past
  // PostToolUseFailure. We pattern-match the standard "[Command (succeeded|
  // failed) with exit code N]" marker — only "failed" (and any explicit
  // non-zero code) triggers; bare "succeeded" returns null.
  if (typeof toolResult === "string") {
    const m = /\[Command (succeeded|failed) with exit code (-?\d+)\]/.exec(toolResult)
    if (m) {
      const status = m[1]
      const code = parseInt(m[2], 10)
      if (status === "failed" || code !== 0) {
        const truncated = toolResult.length > 500 ? toolResult.slice(0, 500) + "…" : toolResult
        return {
          kind: "exit-nonzero",
          message: truncated,
          errorType: classifyApiError({ message: toolResult } as Error),
          isInterrupt: false,
          isTimeout: false
        }
      }
    }
    return null
  }

  if (typeof toolResult !== "object") return null
  const r = toolResult as Record<string, unknown>

  const explicitError =
    r.success === false ||
    r.is_error === true ||
    (typeof r.error === "string" && r.error.trim().length > 0)
  const exitCode = typeof r.exitCode === "number" ? r.exitCode : undefined
  const exitNonZero = exitCode !== undefined && exitCode !== 0
  if (!explicitError && !exitNonZero) return null

  const message =
    (typeof r.error === "string" && r.error) ||
    (typeof r.message === "string" && r.message) ||
    (typeof r.stderr === "string" && r.stderr) ||
    (exitCode !== undefined ? `exit code ${exitCode}` : "tool returned failure")

  return {
    kind: explicitError ? "explicit-error" : "exit-nonzero",
    message,
    errorType: classifyApiError({ message } as Error),
    isInterrupt: false,
    isTimeout: false
  }
}

/**
 * Build the signal for a thrown JS error. Called from toolErrorMiddleware.
 */
export function toolFailureSignalFromThrow(
  err: unknown,
  opts: { aborted?: boolean } = {}
): ToolFailureSignal {
  if (opts.aborted) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      kind: "abort",
      message: msg,
      errorType: "unknown",
      isInterrupt: true,
      isTimeout: false
    }
  }
  const isTimeout =
    err instanceof Error &&
    (err.message.toLowerCase().includes("timeout") || (err as { code?: string }).code === "ETIMEDOUT")
  return {
    kind: isTimeout ? "timeout" : "throw",
    message: err instanceof Error ? err.message : String(err),
    errorType: classifyApiError(err),
    isInterrupt: false,
    isTimeout
  }
}

// ─── Dedupe set ─────────────────────────────────────────────────────────────
// One Set per (threadId|runId) is overkill — failures are sparse, so a single
// global Set with size cap is enough. We never want unbounded growth so callers
// drop entries when they fire (we add) and a sweep keeps it under cap.

const FIRED_CAP = 4096
const firedFailureToolCallIds = new Set<string>()

export function markFailureFired(toolCallId: string): void {
  if (!toolCallId) return
  if (firedFailureToolCallIds.size > FIRED_CAP) {
    // Cheap pruning — drop the first ~512 entries when over cap.
    let dropped = 0
    for (const id of firedFailureToolCallIds) {
      firedFailureToolCallIds.delete(id)
      if (++dropped >= 512) break
    }
  }
  firedFailureToolCallIds.add(toolCallId)
}

export function hasFailureFired(toolCallId: string): boolean {
  return toolCallId !== "" && firedFailureToolCallIds.has(toolCallId)
}

export function clearFailureFiredState(): void {
  firedFailureToolCallIds.clear()
}
