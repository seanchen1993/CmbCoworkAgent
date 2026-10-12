import type { HookResult } from "../../hooks/types"

export function getCompletionHookBlockReason(
  result: HookResult,
  fallback = "Completion hook requested revision"
): string {
  return result.reason || result.stopReason || result.stdout || result.stderr || fallback
}

export function getCompletionHookStopReason(
  result: HookResult,
  fallback = "Completion hook stopped the turn"
): string {
  return result.stopReason || result.reason || result.stdout || result.stderr || fallback
}

/**
 * `continue: false` halts the turn immediately — no revision, no error.
 * Aligns with Claude Code's `preventContinuation` semantics.
 *
 * Plain boolean (not a type guard) so the two helpers compose cleanly across
 * `else if` — declaring `is HookResult` for both makes TS infer `never` in the
 * else branch when the input is already typed as HookResult.
 * Callers should narrow nullability themselves: `r && shouldPreventContinuation(r)`.
 */
export function shouldPreventContinuation(result: HookResult): boolean {
  return result.continue === false
}

/**
 * `decision: "block"` (or exit-code-2 `blocked`) requests a revision — the
 * agent reruns with the hook's reason fed back.
 * Mutually exclusive with `shouldPreventContinuation` at runtime: prevent wins.
 */
export function shouldRequestRevision(result: HookResult): boolean {
  return result.continue !== false && (result.decision === "block" || result.blocked === true)
}

/** Outcome of the completion-hook orchestration loop. */
export type CompletionHookOutcome =
  /** Stop hooks didn't block — turn finished normally. */
  | "passed"
  /** A completion hook returned `continue: false` — turn ended deliberately. */
  | "halted"
  /** Revision retries exhausted — treat as error. */
  | "failed"

export function buildCompletionRevisionPrompt({
  result,
  attempt,
  maxRevisionAttempts,
  hookLabel,
  revisionPromptPrefix
}: {
  result: HookResult
  attempt: number
  maxRevisionAttempts: number
  hookLabel: string
  revisionPromptPrefix: string
}): string {
  const parts = [
    `${revisionPromptPrefix} Internal revision request. Do not mention this marker.`,
    "A completion hook reviewed your previous response and requested a revision.",
    "Revise the work now. Address the issue directly, run any checks that are needed, and then provide an updated final answer.",
    `Revision attempt: ${attempt}/${maxRevisionAttempts}`,
    `Hook type: ${hookLabel}`,
    `Hook reason:\n${getCompletionHookBlockReason(result)}`
  ]
  if (result.additionalContext) {
    parts.push(`Additional hook context:\n${result.additionalContext}`)
  }
  if (result.systemMessage) {
    parts.push(`Hook message:\n${result.systemMessage}`)
  }
  return parts.join("\n\n")
}

export function mergePostSkillUseResults(results: HookResult[]): HookResult | null {
  if (results.length === 0) return null

  const contexts: string[] = []
  const messages: string[] = []
  const revisionReasons: string[] = []
  const stopReasons: string[] = []

  for (const result of results) {
    if (shouldPreventContinuation(result)) {
      stopReasons.push(getCompletionHookStopReason(result, "PostSkillUse hook stopped the turn"))
      if (result.additionalContext) contexts.push(result.additionalContext)
      if (result.systemMessage) messages.push(result.systemMessage)
    } else if (shouldRequestRevision(result)) {
      revisionReasons.push(
        getCompletionHookBlockReason(result, "PostSkillUse hook requested revision")
      )
      if (result.additionalContext) contexts.push(result.additionalContext)
      if (result.systemMessage) messages.push(result.systemMessage)
    }
    // Non-blocking hook output stays observable-only via onHookResult callbacks — do not
    // surface it through the completion result, matching existing PostSkillUse semantics.
  }

  if (stopReasons.length === 0 && revisionReasons.length === 0) return null

  // Any single hook requesting halt wins over revision — match CC's preventContinuation priority.
  const halt = stopReasons.length > 0
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: !halt && revisionReasons.length > 0,
    continue: halt ? false : undefined,
    stopReason: halt ? stopReasons.join("\n") : undefined,
    decision: halt ? undefined : revisionReasons.length > 0 ? "block" : undefined,
    reason: halt ? undefined : revisionReasons.length > 0 ? revisionReasons.join("\n") : undefined,
    additionalContext: contexts.length > 0 ? contexts.join("\n") : undefined,
    systemMessage: messages.length > 0 ? messages.join("\n") : undefined
  }
}
