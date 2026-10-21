import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionUserConfigValues } from "./user-config-values"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"

const schema = parseFunctionUserConfig({
  token: { type: "string", sensitive: true, required: true, title: "Private", description: "" },
  enabled: { type: "boolean", title: "Enabled", description: "", default: false },
  knowledge: { type: "directory", title: "Knowledge", description: "" }
})!
const close: Array<() => void> = []
afterEach(() => close.splice(0).forEach((fn) => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "config-stage-recovery-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  close.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const values = new FunctionUserConfigValues(store, testSecretProtector())
  values.saveSensitive(
    "source",
    "native",
    schema,
    "token",
    { operation: "set", value: "private-fixture" },
    0,
    () => {}
  )
  values.save("source", "native", schema, "enabled", true, 1, () => {})
  values.save("source", "native", schema, "knowledge", "C:/source-knowledge", 2, () => {})
  return { store, values }
}

it("preserves ordinary values, privately re-seals secrets and rebinds only a declared directory", () => {
  const f = fixture()
  const source = f.values.captureStageRecovery("source", "native", schema)
  expect(JSON.stringify(source)).not.toContain("private-fixture")
  f.values.forkStageRecovery(source, "branch", { knowledge: "C:/private-copy" }, () => {})
  expect(f.values.resolve("branch", "native", schema)).toEqual({
    token: "private-fixture",
    enabled: true,
    knowledge: "C:/private-copy"
  })
  expect(f.values.read("branch", "native").sealed?.token).not.toBe(source.record.sealed?.token)
  expect(JSON.stringify(f.values.read("branch", "native"))).not.toContain("private-fixture")
  expect(f.values.resolve("source", "native", schema).knowledge).toBe("C:/source-knowledge")
  expect(f.values.stageRecoveryMatches(source, "branch", { knowledge: "C:/private-copy" })).toBe(
    true
  )
})

it("does not overwrite existing configuration or reuse the original workspace", () => {
  const f = fixture(),
    snapshot = f.values.captureStageRecovery("source", "native", schema)
  f.values.save("branch", "native", schema, "enabled", false, 0, () => {})
  expect(() => f.values.forkStageRecovery(snapshot, "branch", {}, () => {})).toThrow(
    "VALUE_CHANGED"
  )
  expect(() => f.values.forkStageRecovery(snapshot, "source", {}, () => {})).toThrow(
    "VALUE_CHANGED"
  )
})

it("rejects revoked or changed source configuration, forbidden overrides and stale caller", () => {
  const f = fixture(),
    snapshot = f.values.captureStageRecovery("source", "native", schema)
  expect(() =>
    f.values.forkStageRecovery(snapshot, "branch", { token: "override" }, () => {})
  ).toThrow("USER_CONFIG_INVALID")
  expect(() =>
    f.values.forkStageRecovery(snapshot, "branch", {}, () => {
      throw Error("STALE")
    })
  ).toThrow("STALE")
  expect(f.values.read("branch", "native").revision).toBe(0)
  f.values.saveSensitive("source", "native", schema, "token", { operation: "clear" }, 3, () => {})
  expect(() => f.values.forkStageRecovery(snapshot, "branch", {}, () => {})).toThrow(
    "VALUE_CHANGED"
  )
})

it("does not snapshot plaintext legacy secrets or undeclared old values", () => {
  const f = fixture()
  const key = "function-user-config:" + JSON.stringify(["source", "native"])
  const original = f.values.read("source", "native")
  f.store.setSetting(
    key,
    JSON.stringify({ ...original, values: { ...original.values, unknown: "discard" } })
  )
  expect(
    f.values.captureStageRecovery("source", "native", schema).record.values
  ).not.toHaveProperty("unknown")
  f.store.setSetting(
    key,
    JSON.stringify({ ...original, values: { ...original.values, token: "plain-legacy" } })
  )
  expect(() => f.values.captureStageRecovery("source", "native", schema)).toThrow()
})
