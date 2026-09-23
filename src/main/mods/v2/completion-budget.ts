import { AsyncLocalStorage } from "node:async_hooks"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { CompletionGate } from "../../agent/skill-lifecycle/completion-gate"

export interface CompletionReservation {
  settle(inputTokens?: number, outputTokens?: number): void
}

/** Host-owned total usage and conservative in-flight reservations across checks and repairs. */
export class CompletionBudget {
  readonly deadline: number
  outputReserved = 0
  inputTokens = 0
  outputTokens = 0
  private pendingTokens = 0
  private failure?: ModFunctionError

  constructor(
    readonly tokenLimit: number,
    timeoutMs: number,
    private readonly now: () => number = Date.now
  ) {
    this.deadline = now() + timeoutMs
  }

  assert(): void {
    if (!this.failure && this.now() >= this.deadline)
      this.failure = new ModFunctionError("MODS_COMPLETION_TIMEOUT")
    if (this.failure) throw this.failure
  }

  remainingMs(): number {
    this.assert()
    return Math.max(1, this.deadline - this.now())
  }

  availableTokens(): number {
    this.assert()
    return Math.max(0, this.tokenLimit - this.inputTokens - this.outputTokens - this.pendingTokens)
  }

  assertSettled(): void {
    this.assert()
    if (this.pendingTokens > 0) this.fail("MODS_COMPLETION_USAGE_PENDING")
  }

  private fail(code: string): never {
    this.failure ??= new ModFunctionError(code)
    throw this.failure
  }

  charge(inputTokens?: number, outputTokens?: number): void {
    if (![inputTokens, outputTokens].every((value) => Number.isSafeInteger(value) && value! >= 0))
      this.fail("MODS_COMPLETION_USAGE_UNAVAILABLE")
    this.inputTokens += inputTokens!
    this.outputTokens += outputTokens!
    if (this.inputTokens + this.outputTokens + this.pendingTokens > this.tokenLimit)
      this.fail("MODS_COMPLETION_MODEL_BUDGET")
    this.assert()
  }

  reserve(inputUpperBound: number, outputMax: number): CompletionReservation {
    this.assert()
    const tokens = inputUpperBound + outputMax
    if (
      !Number.isSafeInteger(inputUpperBound) ||
      inputUpperBound < 0 ||
      !Number.isSafeInteger(outputMax) ||
      outputMax < 1 ||
      this.inputTokens + this.outputTokens + this.pendingTokens + tokens > this.tokenLimit
    )
      this.fail("MODS_COMPLETION_MODEL_BUDGET")
    this.pendingTokens += tokens
    this.outputReserved += outputMax
    let settled = false
    return {
      settle: (input, output) => {
        if (settled) this.fail("MODS_COMPLETION_USAGE_DUPLICATE")
        settled = true
        this.pendingTokens -= tokens
        this.charge(input, output)
      }
    }
  }
}

const current = new AsyncLocalStorage<{ budget: CompletionBudget; active: boolean }>()

export async function withCompletionBudget<T>(
  budget: CompletionBudget,
  run: () => Promise<T>
): Promise<T> {
  const frame = { budget, active: true }
  budget.assert()
  try {
    const result = await current.run(frame, run)
    budget.assertSettled()
    return result
  } finally {
    frame.active = false
  }
}

/** Called at the real provider boundary, after observers and model configuration resolve. */
export function currentCompletionBudget(): CompletionBudget | undefined {
  const frame = current.getStore()
  if (!frame) return undefined
  if (!frame.active) throw new ModFunctionError("MODS_COMPLETION_SCOPE_EXPIRED")
  return frame.budget
}

export function reserveCompletionModelUsage(
  inputUpperBound: number,
  outputMax: number
): CompletionReservation | undefined {
  return currentCompletionBudget()?.reserve(inputUpperBound, outputMax)
}

export function chargeCompletionModelUsage(inputTokens?: number, outputTokens?: number): void {
  currentCompletionBudget()?.charge(inputTokens, outputTokens)
}

const gateBudgets = new WeakMap<CompletionGate, CompletionBudget>()
export function bindCompletionGateBudget(gate: CompletionGate, budget: CompletionBudget): void {
  gateBudgets.set(gate, budget)
}
export function completionGateBudget(gate: CompletionGate): CompletionBudget | undefined {
  return gateBudgets.get(gate)
}
