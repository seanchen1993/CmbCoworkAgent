import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionUiResolvePhysicalLifetime } from "./ui-resolve-main-quota"

/** Native physical incarnation. Abort/kill-send never stand in for exit or host finally. */
export class FunctionUiResolveHostLifetime implements FunctionUiResolvePhysicalLifetime {
  readonly disposed: Promise<void>
  readonly hostDrained: Promise<void>
  private readonly exit: () => void
  private readonly drain: () => void
  private sealed = false
  private exited = false
  private pending = 0

  constructor(
    readonly owner: object,
    private readonly limit = 512
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
      throw new ModFunctionError("MODS_HOST_CAPACITY")
    let exit!: () => void
    let drain!: () => void
    this.disposed = new Promise<void>((resolve) => {
      exit = resolve
    })
    this.hostDrained = new Promise<void>((resolve) => {
      drain = resolve
    })
    this.exit = exit
    this.drain = drain
  }

  assertCurrent(): void {
    if (this.sealed || this.exited) throw new ModFunctionError("MODS_UI_RESOLVE_RETIRED")
  }

  /** Count before invoking native work, including synchronous re-entry and synchronous throws. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertCurrent()
    if (this.pending >= this.limit) throw new ModFunctionError("MODS_HOST_CAPACITY")
    this.pending++
    try {
      return await work()
    } finally {
      this.pending--
      this.finish()
    }
  }

  seal(): void {
    this.sealed = true
    this.finish()
  }

  /** Called only from the actual child exit listener, including exits after stop/replacement. */
  confirmExit(): void {
    if (this.exited) return
    this.exited = true
    this.seal()
    this.exit()
  }

  private finish(): void {
    // A temporarily idle live owner may admit later work; only a sealed owner is terminal.
    if (this.sealed && this.pending === 0) this.drain()
  }
}
