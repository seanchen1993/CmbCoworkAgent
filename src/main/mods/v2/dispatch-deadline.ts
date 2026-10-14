import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { FunctionSharedWallCut } from "./shared-wall-cut"

/** Bounds caller waits without pretending that an abort-ignoring host effect has finished. */
export class FunctionDispatchDeadline {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private closed = false
  private readonly cut: FunctionSharedWallCut
  readonly signal: AbortSignal

  constructor(ms: number, parent?: AbortSignal, inheritedCutNs?: string) {
    const timeoutMs = Math.min(Math.max(ms, 1), 120000)
    const local = FunctionSharedWallCut.after(timeoutMs)
    const inherited = inheritedCutNs === undefined ? undefined : new FunctionSharedWallCut(inheritedCutNs)
    this.cut = inherited && BigInt(inherited.expiresAtNs) < BigInt(local.expiresAtNs)
      ? inherited : local
    this.signal = parent
      ? AbortSignal.any([parent, this.controller.signal])
      : this.controller.signal
    this.timer = setTimeout(() => this.expire(), Math.max(1, this.cut.remainingMs()))
  }

  get sharedCutNs(): string { return this.cut.expiresAtNs }

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
    if (this.cut.remainingMs() <= 0) {
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
  }
}
