import { expect, it } from "vitest"
import { functionSettingsRequest, readFunctionSettings } from "./settings-sdk"
import type { ModJson } from "../../../shared/mods/types"

it("does not pretend to load Claude source files", () => {
  expect(functionSettingsRequest({})).toEqual({})
  for (const source of ["user", "project", "local", "flag", "policy", null])
    expect(() => functionSettingsRequest({ source })).toThrow("MODS_SETTINGS_SOURCE_UNSUPPORTED")
  expect(() => functionSettingsRequest({ unknown: true })).toThrow("MODS_SETTINGS_ARGUMENTS")
})

it("returns a detached, protected actual CMB effective snapshot", async () => {
  const snapshot = { cmbdevclaw: { model: "actual-model", runtime: { recursionLimit: 88 } } }
  const c = {
    snapshot: async () => snapshot,
    signal: new AbortController().signal,
    assertLive() {
      /* Live host fixture. */
    },
    publish: async (value: ModJson) => value
  }
  const result = await readFunctionSettings({}, c)
  expect(result).toEqual(snapshot)
  expect(result).not.toBe(snapshot)
  expect(result.cmbdevclaw).not.toBe(snapshot.cmbdevclaw)
  c.publish = async () => ({ cmbdevclaw: { model: "[protected]" } })
  expect(await readFunctionSettings({}, c)).toEqual({ cmbdevclaw: { model: "[protected]" } })
})

it("rejects authority loss after async reads and invalid/oversized host snapshots", async () => {
  const c = {
    snapshot: async () => ({ cmbdevclaw: {} }),
    signal: new AbortController().signal,
    assertLive() {
      /* Live host fixture. */
    },
    publish: async (value: ModJson) => value
  }
  c.snapshot = async () => {
    c.assertLive = () => {
      throw new Error("revoked")
    }
    return { cmbdevclaw: {} }
  }
  await expect(readFunctionSettings({}, c)).rejects.toThrow("revoked")
  c.assertLive = () => {}
  c.snapshot = async () => ({ cmbdevclaw: { huge: "x".repeat(262145) } })
  await expect(readFunctionSettings({}, c)).rejects.toThrow("MODS_SETTINGS_LIMIT")
})
