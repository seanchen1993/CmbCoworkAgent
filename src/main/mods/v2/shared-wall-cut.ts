import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Private absolute OS-monotonic cut. It never crosses the guest/event/SDK boundary. */
export class FunctionSharedWallCut {
  private readonly tick: bigint

  constructor(readonly expiresAtNs: string) {
    if (!/^[0-9]{1,30}$/.test(expiresAtNs))
      throw new ModFunctionError("MODS_DISPATCH_CUT_INVALID", "MODS_DISPATCH_CUT_INVALID", true)
    this.tick = BigInt(expiresAtNs)
  }

  static after(ms: number): FunctionSharedWallCut {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 120000)
      throw new ModFunctionError("MODS_DISPATCH_CUT_INVALID", "MODS_DISPATCH_CUT_INVALID", true)
    return new FunctionSharedWallCut((process.hrtime.bigint() + BigInt(Math.ceil(ms * 1e6))).toString())
  }

  remainingMs(): number {
    return Math.max(0, Number(this.tick - process.hrtime.bigint()) / 1e6)
  }

  assertLive(): void {
    if (this.remainingMs() <= 0)
      throw new ModFunctionError("MODS_DISPATCH_TIMEOUT", "组件处理超过总等待期限，已停止本次处理", true)
  }
}
