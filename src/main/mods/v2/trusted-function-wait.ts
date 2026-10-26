import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export const FUNCTION_TRUSTED_WAIT_LIMIT_MS = 15 * 60 * 1000
export const FUNCTION_TRUSTED_WAIT_ACK_MS = 1000
type WaitKind = "policy-queue" | "user-approval"
const failure = (code = "MODS_TRUSTED_WAIT_EXPIRED") => new ModFunctionError(code)

/** Private native clock. It does not alter CPU, own-time, process or inherited hard cuts. */
export class FunctionTrustedWaitClock {
  private credit = 0
  private started?: number
  private allowance = 0
  private readonly tickets = new Set<string>()
  private readonly usedTickets = new Set<string>()
  private closed = false
  readonly baseExpiresAt: number
  constructor(ms: number, private readonly now = () => performance.now()) {
    this.baseExpiresAt = now() + ms
  }
  get paused(): boolean { return this.tickets.size > 0 }
  get creditMs(): number { return this.credit }
  get nextCheckMs(): number {
    return Math.max(1, this.expiresAt - this.now() + (this.started === undefined ? 0 :
      Math.max(0, this.allowance - (this.now() - this.started))))
  }
  get expiresAt(): number {
    return this.baseExpiresAt + this.credit + (this.started === undefined ? 0 :
      Math.min(Math.max(0, this.now() - this.started), this.allowance))
  }
  assertLive(): void {
    if (this.closed || this.now() >= this.expiresAt) throw failure("MODS_BUDGET_EXCEEDED")
  }
  assertDispatchAllowed(): void {
    this.assertLive()
    if (this.paused) throw failure("MODS_TRUSTED_WAIT_DISPATCH_BLOCKED")
  }
  begin(id: string, allowance: number): void {
    this.assertLive()
    if (!id || this.usedTickets.has(id) || this.usedTickets.size >= 512 || this.tickets.size >= 32 ||
      !Number.isFinite(allowance) || allowance <= 0 || allowance > FUNCTION_TRUSTED_WAIT_LIMIT_MS)
      throw failure("MODS_TRUSTED_WAIT_INVALID")
    if (!this.tickets.size) { this.started = this.now(); this.allowance = allowance }
    else this.allowance = Math.min(this.allowance, this.now() - this.started! + allowance)
    this.usedTickets.add(id)
    this.tickets.add(id)
  }
  end(id: string, authoritativeCredit?: number): void {
    this.assertLive()
    if (!this.tickets.delete(id)) throw failure("MODS_TRUSTED_WAIT_STALE")
    const now = this.now()
    const elapsed = Math.min(Math.max(0, now - this.started!), this.allowance)
    if (authoritativeCredit !== undefined) {
      if (!Number.isFinite(authoritativeCredit) || authoritativeCredit < this.credit ||
        authoritativeCredit > FUNCTION_TRUSTED_WAIT_LIMIT_MS)
        throw failure("MODS_TRUSTED_WAIT_INVALID")
      this.credit = authoritativeCredit
    } else this.credit += elapsed
    if (this.credit > FUNCTION_TRUSTED_WAIT_LIMIT_MS) throw failure()
    this.started = this.tickets.size ? now : undefined
    this.allowance = Math.max(0, this.allowance - elapsed)
    this.assertLive()
  }
  close(): void { this.closed = true; this.tickets.clear(); this.started = undefined }
}

export interface TrustedFunctionWaitParticipant {
  clock: FunctionTrustedWaitClock
  assertCurrent(): void
  /** Must ACK the exact live transport/frame; only native main code supplies this endpoint. */
  prepare?(id: string, allowanceMs: number): Promise<void>
  finish?(id: string, creditMs: number): Promise<void>
  abort(error: Error): void
  changed?(): void
}

interface Owner {
  active: Set<string>
  spent: number
  started?: number
  closed: boolean
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}
interface Scope { owner: Owner; chain: readonly TrustedFunctionWaitParticipant[] }
const scopes = new AsyncLocalStorage<Scope | undefined>()

/** Mirror existing fresh/closed execution-owner boundaries; this grants no new authority. */
export function withoutTrustedFunctionWaitScope<T>(run: () => T): T {
  // exit() only disables the ALS instance: a synchronous nested run() can re-enable
  // it and restore the old creator store across await. A fresh owner needs an
  // explicit empty store so its later callbacks cannot borrow that closed owner.
  return scopes.run(undefined, run)
}

/** Only the exact causal stack inherits this owner; sibling sessions never share tickets. */
export function createTrustedFunctionWaitScope(participant?: TrustedFunctionWaitParticipant) {
  const parent = scopes.getStore()
  const owner: Owner = parent?.owner ?? {
    active: new Set(), spent: 0, closed: false, controller: new AbortController()
  }
  const scope = { owner, chain: [...(parent?.chain ?? []), ...(participant ? [participant] : [])] }
  let closed = false
  return {
    run<T>(run: () => T): T {
      if (closed || owner.closed) throw failure("MODS_TRUSTED_WAIT_STALE")
      return scopes.run(scope, run)
    },
    close() {
      if (closed) return
      closed = true
      participant?.clock.close()
      if (!parent) {
        owner.closed = true
        clearTimeout(owner.timer)
        owner.controller.abort(failure("MODS_INVOCATION_ENDED"))
      }
    }
  }
}

export async function withTrustedFunctionWaitScope<T>(
  participant: TrustedFunctionWaitParticipant, run: () => Promise<T>
): Promise<T> {
  const scope = createTrustedFunctionWaitScope(participant)
  try { return await scope.run(run) }
  finally { scope.close() }
}

async function waitBounded<T>(work: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  void work.catch(() => {})
  signal.throwIfAborted()
  let detach = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(signal.reason ?? failure("MODS_CANCELLED"))
    signal.addEventListener("abort", abort, { once: true })
    detach = () => signal.removeEventListener("abort", abort)
    if (signal.aborted) abort()
    if (timeoutMs !== undefined) timer = setTimeout(() => reject(failure("MODS_TRUSTED_WAIT_ACK_TIMEOUT")), timeoutMs)
  })
  try { return await Promise.race([work, stopped]) }
  finally { detach(); clearTimeout(timer) }
}

/** This function is called only by native policy/dialog code, never by SDK arguments. */
export async function withTrustedFunctionWait<T>(
  kind: WaitKind, signal: AbortSignal | undefined, work: () => Promise<T>
): Promise<T> {
  const scope = scopes.getStore()
  if (!scope) return work()
  if (kind !== "policy-queue" && kind !== "user-approval") throw failure("MODS_TRUSTED_WAIT_INVALID")
  const { owner, chain } = scope
  const active = signal ? AbortSignal.any([signal, owner.controller.signal]) : owner.controller.signal
  const now = () => performance.now()
  const remaining = () => FUNCTION_TRUSTED_WAIT_LIMIT_MS - owner.spent -
    (owner.started === undefined ? 0 : Math.max(0, now() - owner.started))
  const assertCurrent = () => {
    active.throwIfAborted()
    if (owner.closed || remaining() <= 0) throw failure()
    for (const participant of chain) { participant.assertCurrent(); participant.clock.assertLive() }
  }
  const id = randomUUID()
  const prepared: TrustedFunctionWaitParticipant[] = []
  let entered = false
  const begun: TrustedFunctionWaitParticipant[] = []
  let failureValue: unknown
  let normalWorkFailure = false
  try {
    assertCurrent()
    // Main clocks remain charged during ACK. Partial ACK failure aborts, never refunds time.
    for (const participant of chain) {
      if (participant.prepare) {
        await waitBounded(participant.prepare(id, remaining()), active, FUNCTION_TRUSTED_WAIT_ACK_MS)
        assertCurrent()
      }
      prepared.push(participant)
    }
    assertCurrent()
    if (!owner.active.size) {
      owner.started = now()
      owner.timer = setTimeout(() => owner.controller.abort(failure()), remaining())
    }
    owner.active.add(id)
    entered = true
    for (const participant of chain) {
      participant.clock.begin(id, remaining())
      begun.push(participant)
      participant.changed?.()
    }
    const result = await waitBounded(Promise.resolve().then(() => {
      assertCurrent()
      return Promise.resolve().then(work).then(value => ({ ok: true as const, value }),
        error => ({ ok: false as const, error }))
    }), active)
    assertCurrent()
    if (!result.ok) { normalWorkFailure = true; throw result.error }
    return result.value
  } catch (error) {
    if (!normalWorkFailure) failureValue = error
    throw error
  } finally {
    try {
      if (entered) {
        owner.active.delete(id)
        if (!owner.active.size) {
          owner.spent += Math.max(0, now() - owner.started!)
          owner.started = undefined
          clearTimeout(owner.timer)
        }
        for (const participant of begun) {
          participant.clock.end(id)
          participant.changed?.()
        }
        for (const participant of prepared) {
          if (participant.finish) await waitBounded(
            participant.finish(id, participant.clock.creditMs), active, FUNCTION_TRUSTED_WAIT_ACK_MS)
        }
        assertCurrent()
      }
    } catch (error) {
      failureValue ??= error
      // Cleanup is a final trust fence: an expired deadline or missing ACK must
      // reject even a returned work value, never publish it as trusted success.
      // eslint-disable-next-line no-unsafe-finally
      throw error
    } finally {
      if (failureValue !== undefined) {
        const error = failureValue instanceof Error ? failureValue : failure()
        owner.controller.abort(error)
        for (const participant of chain) {
          try { participant.abort(error) }
          catch { /* A dead transport cannot keep the other ancestors admitted. */ }
          finally { participant.clock.close() }
        }
      }
    }
  }
}
