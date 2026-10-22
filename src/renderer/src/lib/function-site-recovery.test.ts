import { expect, it } from "vitest"
import { FunctionSiteRecovery, isTransientFunctionSiteError } from "./function-site-recovery"

it("matches exact lifecycle codes including Electron envelopes without broad fallback", () => {
  for (const code of [
    "MODS_ENTRY_EXPIRED",
    "MODS_RUNTIME_INSTANCE_EXPIRED",
    "MODS_DEVELOPMENT_APPLYING",
    "MODS_UI_DRAWING_STALE",
    "MODS_UI_SITE_CLOSED",
    "MODS_SESSION_CLOSED",
    "MODS_DISPLAY_ROW_CHANGED"
  ])
    expect(
      isTransientFunctionSiteError(new Error("Error invoking remote method: Error: " + code))
    ).toBe(true)
  for (const code of [
    "MODS_SCOPE_CHANGED",
    "MODS_UI_QUESTION_STALE",
    "MODS_UI_SITE_CLOSED_PERMANENT",
    "MODS_RUNTIME_LOST",
    "MODS_RUNTIME_SOURCE_CHANGED",
    "MODS_DISPLAY_SCOPE_CHANGED"
  ])
    expect(isTransientFunctionSiteError({ code })).toBe(false)
})

it("bounds autonomous retry credit and throttles notifications until validated success", () => {
  const recovery = new FunctionSiteRecovery()
  expect(recovery.failed(true)).toBe(150)
  recovery.started(1000)
  expect(recovery.notificationDelay(1100)).toBe(300)
  expect(recovery.failed(true)).toBe(400)
  expect(recovery.failed(true)).toBe(1000)
  expect(recovery.failed(true)).toBe(2000)
  for (let i = 0; i < 100; i++) expect(recovery.failed(true)).toBeUndefined()
  expect(recovery.notificationDelay(2000)).toBe(0)
  recovery.reset()
  expect(recovery.failed(true)).toBe(150)
  expect(recovery.failed(false)).toBeUndefined()
})

it("new reads and permanent failures cannot refill retirement retry credit", () => {
  const recovery = new FunctionSiteRecovery()
  for (const [index, delay] of [150, 400, 1000, 2000].entries()) {
    recovery.started(index * 1000)
    recovery.notificationDelay(index * 1000 + 500)
    expect(recovery.failed(false)).toBeUndefined()
    expect(recovery.failed(true)).toBe(delay)
  }
  recovery.started(10000)
  expect(recovery.failed(true)).toBeUndefined()
  expect(recovery.failed(false)).toBeUndefined()
  expect(recovery.failed(true)).toBeUndefined()
})
