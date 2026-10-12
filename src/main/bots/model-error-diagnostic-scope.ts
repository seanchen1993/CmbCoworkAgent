import { AsyncLocalStorage } from "node:async_hooks"
import { BotDomainError } from "../../shared/bot-types"
import type { BotErrorDiagnostic } from "../../shared/bot-error-diagnostic"
import type { CmbModelInvocationObserver } from "../models/model-factory"
import { safeBotErrorDiagnostic, safeBotErrorText } from "./error-diagnostic"

export type BotModelFailureProvenance = Omit<BotErrorDiagnostic, "code">
interface Scope {
  owner: symbol
  active: boolean
  lastAttempt?: BotModelFailureProvenance
  secrets: readonly string[]
}
export interface CapturedBotModelFailure {
  message: string
  provenance?: BotModelFailureProvenance
}
const invocations = new AsyncLocalStorage<Scope>()
const captured = new WeakMap<object, CapturedBotModelFailure>()

function cause(value: object): unknown {
  return Object.getOwnPropertyDescriptor(value, "cause")?.value
}

export function capturedBotModelFailure(error: unknown): CapturedBotModelFailure | undefined {
  const visited = new Set<object>()
  let current = error
  while (current && typeof current === "object" && visited.size < 64 && !visited.has(current)) {
    visited.add(current)
    const value = captured.get(current)
    if (value)
      return { ...value, ...(value.provenance ? { provenance: { ...value.provenance } } : {}) }
    current = cause(current)
  }
  return undefined
}

export function botModelAttemptStarted(callId: string): void {
  const scope = invocations.getStore()
  if (scope?.active) scope.lastAttempt = { callId }
}

/** Enter a fresh fetch admission before a durable reservation exists. A local
 * rejection of retry N must not inherit retry N-1's HTTP request identity. */
export function botModelAttemptPending(): void {
  const scope = invocations.getStore()
  if (scope?.active) scope.lastAttempt = undefined
}

export function botModelAttemptResponse(provenance: BotModelFailureProvenance): void {
  const scope = invocations.getStore()
  if (scope?.active && scope.lastAttempt?.callId === provenance.callId)
    scope.lastAttempt = { ...provenance }
}

/** Explicit fetch ownership also covers a provider SDK wrapping its transport
 * error in a new Error/cause; no async-context propagation across worker IPC is assumed. */
export function captureBotModelAttemptFailure(
  error: unknown,
  provenance: BotModelFailureProvenance,
  secrets: readonly string[] = []
): void {
  if (!error || typeof error !== "object") return
  const diagnostic = safeBotErrorDiagnostic({ code: "runtime_failed", ...provenance }, secrets)
  const safe: BotModelFailureProvenance = {
    ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
    ...(diagnostic.requestId === undefined ? {} : { requestId: diagnostic.requestId }),
    ...(diagnostic.correlationId === undefined ? {} : { correlationId: diagnostic.correlationId }),
    ...(diagnostic.callId === undefined ? {} : { callId: diagnostic.callId })
  }
  captured.set(error, {
    message: safeBotErrorText(
      error instanceof Error ? error.message : "模型请求失败",
      2000,
      secrets
    ),
    // A local admission/ownership failure has no upstream request to attribute.
    ...(error instanceof BotDomainError ? {} : { provenance: safe })
  })
}

function failed(error: unknown, scope: Scope): void {
  if (!scope.active || !error || typeof error !== "object") return
  const previous = capturedBotModelFailure(error)
  const provenance =
    error instanceof BotDomainError ? undefined : (previous?.provenance ?? scope.lastAttempt)
  captured.set(error, {
    message:
      previous?.message ??
      safeBotErrorText(
        error instanceof Error ? error.message : "模型调用失败",
        2000,
        scope.secrets
      ),
    ...(provenance === undefined ? {} : { provenance: { ...provenance } })
  })
}

/** Factory completions are reused by withConfig/bindTools. A distinct scope per
 * invocation and per async iterator operation prevents cross-call attribution. */
export function botModelInvocationObserver(
  secrets: readonly string[] = []
): CmbModelInvocationObserver {
  const owner = Symbol("model invocation")
  return {
    run<T>(execute: () => Promise<T>): Promise<T> {
      if (invocations.getStore()?.owner === owner && invocations.getStore()?.active)
        return execute()
      const scope: Scope = { owner, active: true, secrets }
      return invocations.run(scope, async () => {
        try {
          return await execute()
        } catch (error) {
          failed(error, scope)
          throw error
        } finally {
          scope.active = false
        }
      })
    },
    stream<T>(execute: () => AsyncGenerator<T>): AsyncGenerator<T> {
      if (invocations.getStore()?.owner === owner && invocations.getStore()?.active)
        return execute()
      const scope: Scope = { owner, active: true, secrets }
      const iterator = invocations.run(scope, execute)
      const invoke = async (operation: () => Promise<IteratorResult<T>>) => {
        try {
          const result = await invocations.run(scope, operation)
          if (result.done) scope.active = false
          return result
        } catch (error) {
          failed(error, scope)
          scope.active = false
          throw error
        }
      }
      return {
        next: (...args) => invoke(() => iterator.next(...args)),
        throw: (error) => invoke(() => iterator.throw(error)),
        return: (value) => invoke(() => iterator.return(value)),
        [Symbol.asyncDispose]: async () => {
          await invoke(() => iterator.return(undefined))
        },
        [Symbol.asyncIterator]() {
          return this
        }
      }
    }
  }
}
