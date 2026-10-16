import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Monotonic native facts. Never copied from a guest event or cleared on an idle callback. */
export class FunctionGuestExecutionFacts {
  private entered = false
  private hostCalls = false
  private sealed = false

  get guestEntered(): boolean {
    return this.entered
  }
  get hostCallAttempted(): boolean {
    return this.hostCalls
  }
  get registrationSealed(): boolean {
    return this.sealed
  }

  enterGuest(): void {
    if (this.sealed) throw new ModFunctionError("MODS_ENTRY_EXPIRED")
    this.entered = true
  }

  enterHostCall(): void {
    this.enterGuest()
    this.hostCalls = true
  }

  sealRegistration(): boolean {
    if (this.entered || this.hostCalls || this.sealed) return false
    this.sealed = true
    return true
  }
}
