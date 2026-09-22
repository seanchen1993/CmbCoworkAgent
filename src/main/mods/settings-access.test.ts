import { expect, it } from "vitest"
import { ModsSettingsAccess } from "./settings-access"

it("rejects missing, malformed and incorrect passwords without unlocking settings", () => {
  const access = new ModsSettingsAccess()
  const sender = {}
  for (const password of [undefined, null, true, {}, "", "admin", "admin123456 "]) {
    expect(() => access.unlock(sender, password)).toThrow("MODS_FUNCTION_PASSWORD_INVALID")
    expect(access.isUnlocked(sender)).toBe(false)
    expect(() => access.assertUnlocked(sender)).toThrow("MODS_FUNCTION_LOCKED")
  }
})

it("unlocks only the verified renderer and resets for a new app session", () => {
  const access = new ModsSettingsAccess()
  const sender = {}
  expect(access.unlock(sender, "admin123456")).toBe(true)
  expect(() => access.assertUnlocked(sender)).not.toThrow()
  expect(() => access.assertUnlocked({})).toThrow("MODS_FUNCTION_LOCKED")
  expect(new ModsSettingsAccess().isUnlocked(sender)).toBe(false)
})
