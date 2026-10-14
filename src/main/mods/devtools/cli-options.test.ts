import { expect, it } from "vitest"
import { functionCheckExitCode, parseFunctionCheckOptions } from "./cli-options"

it("preserves ordinary package checks and supports explicit strict event compatibility", () => {
  expect(parseFunctionCheckOptions(["check", "C:/plugin"])).toEqual({
    command: "check",
    directory: "C:/plugin",
    strictCompatibility: false
  })
  for (const args of [
    ["check", "C:/plugin", "--strict-compatibility"],
    ["inspect", "--strict-compatibility", "C:/plugin"]
  ])
    expect(parseFunctionCheckOptions(args)?.strictCompatibility).toBe(true)
})

it.each([
  [],
  ["run", "x"],
  ["check"],
  ["check", "x", "y"],
  ["check", "--unknown"],
  ["check", "x", "--strict"],
  ["check", "x", "--strict-compatibility", "--strict-compatibility"]
])("rejects invalid CLI arguments %j", (...args) => {
  expect(parseFunctionCheckOptions(args)).toBeUndefined()
})

it("fails strict checks for unavailable events without changing normal validation exits", () => {
  const limited = { valid: true, compatibility: { strictCompatible: false } }
  expect(functionCheckExitCode(limited, false)).toBe(0)
  expect(functionCheckExitCode(limited, true)).toBe(1)
  const usableObserver = {
    valid: true,
    compatibility: { strictCompatible: true },
    sdkCompatibility: { strictCompatible: true }
  }
  expect(functionCheckExitCode(usableObserver, true)).toBe(0)
  expect(functionCheckExitCode({ ...usableObserver, valid: false }, false)).toBe(1)
  expect(functionCheckExitCode({ ...usableObserver, valid: false }, true)).toBe(1)
})

it("fails strict checks when SDK analysis fails or was not performed", () => {
  const eventOnly = { valid: true, compatibility: { strictCompatible: true } }
  expect(functionCheckExitCode(eventOnly, true)).toBe(1)
  const unsupportedSdk = { ...eventOnly, sdkCompatibility: { strictCompatible: false } }
  expect(functionCheckExitCode(unsupportedSdk, true)).toBe(1)
  expect(functionCheckExitCode(unsupportedSdk, false)).toBe(0)
})

it("accepts explicit type checks while rejecting duplicate flags", () => {
  expect(
    parseFunctionCheckOptions(["check", "x", "--types", "--strict-compatibility"])
  ).toMatchObject({ typecheck: true, strictCompatibility: true })
  expect(parseFunctionCheckOptions(["check", "x", "--types", "--types"])).toBeUndefined()
})
