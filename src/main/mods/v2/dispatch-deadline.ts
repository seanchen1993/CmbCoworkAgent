import { FunctionTrustedWaitClock, createTrustedFunctionWaitScope } from "./trusted-function-wait"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionSharedWallCut } from "./shared-wall-cut"

/** Bounds caller waits without pretending that an abort-ignoring host effect has finished. */
export class FunctionDispatchDeadline {
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private closed = false
  private readonly cut: FunctionSharedWallCut
  private readonly waitClock?: FunctionTrustedWaitClock
  private readonly waitScope?: ReturnType<typeof createTrustedFunctionWaitScope>
  readonly signal: AbortSignal

  constructor(ms: number, parent?: AbortSignal, inheritedCutNs?: string, trustedWait = false) {
    const timeoutMs = Math.min(Math.max(ms, 1), 120000)
    const local = FunctionSharedWallCut.after(timeoutMs)
    const inherited = inheritedCutNs === undefined ? undefined : new FunctionSharedWallCut(inheritedCutNs)
    this.cut = inherited && BigInt(inherited.expiresAtNs) < BigInt(local.expiresAtNs)
      ? inherited : local
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal
    if (trustedWait && inheritedCutNs === undefined) {
      this.waitClock = new FunctionTrustedWaitClock(timeoutMs)
      this.waitScope = createTrustedFunctionWaitScope({ clock: this.waitClock,
        assertCurrent: () => this.assertLive(), changed: () => this.arm(),
        abort: error => this.controller.abort(error) })
    }
    this.timer = setTimeout(() => this.checkExpiry(), this.remainingMs())
  }

  get sharedCutNs(): string { return this.cut.expiresAtNs }

  run<T>(run: () => T): T { return this.waitScope ? this.waitScope.run(run) : run() }

  private remainingMs(): number {
    return Math.max(1, this.waitClock ? this.waitClock.expiresAt - performance.now() : this.cut.remainingMs())
  }
  private arm(): void {
    clearTimeout(this.timer)
    if (!this.closed) this.timer = setTimeout(() => this.checkExpiry(),
      this.waitClock?.nextCheckMs ?? this.remainingMs())
  }
  private checkExpiry(): void {
    if (this.waitClock && performance.now() < this.waitClock.expiresAt) this.arm()
    else this.expire()
  }

  private expire(): void {
    this.controller.abort(
      new ModFunctionError("MODS_DISPATCH_TIMEOUT", "组件处理超过总等待期限，已停止本次处理", true)
    )
  }

  private failure(): ModFunctionError {
    return this.controller.signal.reason instanceof ModFunctionError
      ? this.controller.signal.reason
      : new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
  }

  assertLive(): void {
    if (this.signal.aborted) throw this.failure()
    if (this.closed)
      throw new ModFunctionError("MODS_INVOCATION_ENDED", "MODS_INVOCATION_ENDED", true)
    if (this.waitClock ? performance.now() >= this.waitClock.expiresAt : this.cut.remainingMs() <= 0) {
      this.expire()
      throw this.failure()
    }
  }

  async wait<T>(actual: Promise<T>): Promise<T> {
    // Attach before checking the signal so even a pre-aborted caller consumes a late rejection.
    void actual.catch(() => {})
    this.assertLive()
    let cancel!: () => void
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(this.failure())
      this.signal.addEventListener("abort", cancel, { once: true })
      if (this.signal.aborted) cancel()
    })
    try {
      const result = await Promise.race([actual, aborted])
      this.assertLive()
      return result
    } catch (error) {
      this.assertLive()
      throw error
    } finally {
      this.signal.removeEventListener("abort", cancel)
    }
  }

  close(): void {
    this.closed = true
    clearTimeout(this.timer)
    this.waitScope?.close()
  }
}
