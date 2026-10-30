import { ModError } from "./errors"

/** A local settings gate, scoped to the current renderer and reset on app restart. */
export class ModsSettingsAccess {
  private readonly unlocked = new WeakSet<object>()

  isUnlocked(sender: object): boolean {
    return this.unlocked.has(sender)
  }

  unlock(sender: object, password: unknown): true {
    if (password !== "admin123456") throw new ModError("MODS_FUNCTION_PASSWORD_INVALID")
    this.unlocked.add(sender)
    return true
  }

  assertUnlocked(sender: object): void {
    if (!this.isUnlocked(sender)) throw new ModError("MODS_FUNCTION_LOCKED")
  }
}
