import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionDispatchDeadline } from "./dispatch-deadline"

/** Actual classic work survives a caller cut; a later quit can bound an existing waiter. */
export class FunctionClassicEndStage<T = unknown> {
  readonly actual: Promise<T>
  private readonly attached = Promise.withResolvers<FunctionDispatchDeadline>()
  private drain?: FunctionDispatchDeadline
  private active = true

  constructor(run: () => Promise<T>) {
    this.actual = Promise.resolve()
      .then(() => {
        this.assertLive()
        return run()
      })
      .finally(() => {
        this.active = false
      })
    void this.actual.catch(() => {})
  }

  attach(drain: FunctionDispatchDeadline): void {
    if (this.drain) return
    this.drain = drain
    this.attached.resolve(drain)
  }

  assertLive(): void {
    if (!this.active) throw new ModFunctionError("MODS_SESSION_ENDING")
    this.drain?.assertLive()
  }

  /** Unlike an initial Promise.race snapshot, this also observes a subsequently attached cut. */
  async wait(): Promise<T> {
    const result = await Promise.race([
      this.actual,
      this.attached.promise.then((drain) => drain.wait(this.actual))
    ])
    // A blocked event loop can resolve actual before the timeout callback runs.
    this.drain?.assertLive()
    return result
  }
}
