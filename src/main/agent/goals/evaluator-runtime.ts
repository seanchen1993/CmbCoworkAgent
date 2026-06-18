import type { GoalEvaluationInput } from "./evaluator"
import type { GoalJudgeDecision } from "./types"

export const DEFAULT_GOAL_EVALUATOR_RUNTIME_ATTEMPTS = 3
export const DEFAULT_GOAL_EVALUATOR_RUNTIME_RETRY_DELAY_MS = 750

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
