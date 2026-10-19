import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionUserConfigValues } from "./user-config-values"
import { FunctionUserConfigSecrets } from "./user-config-secrets"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { parseFunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"
import { userConfigSchemaDigest } from "./user-config-migration"

const close: Array<() => void> = []
afterEach(() => {
  for (const fn of close.splice(0)) fn()
})
const field = { type: "string", title: "Text", description: "Help" }
const old = parseFunctionUserConfig({
  old: field,
  obsolete: field,
  private: { ...field, sensitive: true }
})!
const schema = parseFunctionUserConfig({
  current: { ...field, default: "fallback" },
  token: { ...field, sensitive: true }
})!
const declaration = parseFunctionUserConfigSchema(
  {
    version: 1,
    migrations: [
      {
        fromVersion: 0,
        toVersion: 1,
        changes: [
          { kind: "rename", from: "old", to: "current" },
          { kind: "rename", from: "private", to: "token" },
          { kind: "remove", key: "obsolete" }
        ]
      }
    ]
  },
  schema
)!
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "config-migration-")),
    path = join(root, "settings.sqlite")
  let store = new ModControlStore(path)
  const protector = testSecretProtector()
  let values = new FunctionUserConfigValues(store, protector)
  close.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    get values() {
      return values
    },
    protector,
    raw: () => store.getSetting('function-user-config:["w","p"]', ""),
    set: (raw: string) => store.setSetting('function-user-config:["w","p"]', raw),
    reopen: () => {
      store.close()
      store = new ModControlStore(path)
      values = new FunctionUserConfigValues(store, protector)
    }
  }
}
it("migrates real SQLite legacy data once and rebinds secret AAD without exposing secret values", () => {
  const f = fixture()
  f.values.save("w", "p", old, "old", "retained", 0, () => {})
  f.values.save("w", "p", old, "obsolete", "removed-on-confirmation", 1, () => {})
  f.values.saveSensitive(
    "w",
    "p",
    old,
    "private",
    { operation: "set", value: "private-sentinel" },
    2,
    () => {}
  )
  const before = f.raw(),
    ciphertext = f.values.read("w", "p").sealed!.private
  const plan = f.values.migration("w", "p", schema, declaration)!
  expect(plan.view.canApply).toBe(true)
  expect(JSON.stringify(plan.view)).not.toMatch(/private-sentinel|removed-on-confirmation|retained/)
  expect(f.raw()).toBe(before)
  expect(() => f.values.resolve("w", "p", schema, declaration)).toThrow(
    "MODS_USER_CONFIG_MIGRATION_REQUIRED"
  )
  expect(() =>
    f.values.save("w", "p", schema, "current", "bypass", 3, () => {}, declaration)
  ).toThrow("MODS_USER_CONFIG_MIGRATION_REQUIRED")
  expect(
    f.values.migrate("w", "p", schema, declaration, 3, plan.view.digest, () => {}).revision
  ).toBe(4)
  expect(f.values.read("w", "p").values).toEqual({ current: "retained" })
  expect(f.raw()).not.toContain("private-sentinel")
  expect(f.values.read("w", "p").sealed!.token).not.toBe(ciphertext)
  const secrets = new FunctionUserConfigSecrets(f.protector)
  expect(() => secrets.open("w", "p", "token", schema.token, ciphertext)).toThrow(
    "MODS_SECRET_STORAGE_INVALID"
  )
  f.reopen()
  expect(f.values.resolve("w", "p", schema, declaration)).toEqual({
    current: "retained",
    token: "private-sentinel"
  })
  expect(f.values.migration("w", "p", schema, declaration)).toBeUndefined()
})
it("keeps defaults for absent overrides and tags a fresh save without a phantom migration", () => {
  const f = fixture()
  expect(f.values.migration("w", "p", schema, declaration)).toBeUndefined()
  f.values.save("w", "p", schema, "current", "first", 0, () => {}, declaration)
  expect(f.values.read("w", "p")).toMatchObject({
    schemaVersion: 1,
    schemaDigest: userConfigSchemaDigest(schema)
  })
  expect(
    f.values.migration(
      "w",
      "p",
      { ...schema, current: { ...schema.current, title: "New label" } },
      declaration
    )
  ).toBeUndefined()
  const legacy = fixture()
  legacy.values.save("w", "p", old, "obsolete", "only-removed", 0, () => {})
  const plan = legacy.values.migration("w", "p", schema, declaration)!
  legacy.values.migrate("w", "p", schema, declaration, 1, plan.view.digest, () => {})
  expect(legacy.values.resolve("w", "p", schema, declaration).current).toBe("fallback")
})
it("blocks collisions, missing migration paths and schema changes without silently resetting saved values", () => {
  const f = fixture()
  f.set(JSON.stringify({ revision: 5, values: { old: "old", current: "new" } }))
  const before = f.raw()
  const plan = f.values.migration("w", "p", schema, declaration)!
  expect(plan.view.canApply).toBe(false)
  expect(plan.view.diagnostics.join()).toContain("destination")
  expect(() =>
    f.values.migrate("w", "p", schema, declaration, 5, plan.view.digest, () => {})
  ).toThrow("MODS_USER_CONFIG_MIGRATION_BLOCKED")
  expect(f.raw()).toBe(before)
  expect(
    f.values.migration("w", "p", schema, { version: 2, migrations: [] })!.view.diagnostics.join()
  ).toContain("Missing")
  const typed = fixture()
  const initial = parseFunctionUserConfig({
    choice: { ...field, options: ["a", "b"], default: "a" }
  })!
  typed.values.save("w", "p", initial, "choice", "b", 0, () => {}, { version: 1, migrations: [] })
  const narrowed = parseFunctionUserConfig({ choice: { ...field, options: ["a"], default: "a" } })!
  const v2 = { version: 2, migrations: [{ fromVersion: 1, toVersion: 2, changes: [] }] }
  const changed = typed.values.migration("w", "p", narrowed, v2)!
  expect(changed.view.canApply).toBe(false)
  expect(typed.values.read("w", "p").values.choice).toBe("b")
  expect(
    typed.values.migration("w", "p", narrowed, { version: 1, migrations: [] })!.view.canApply
  ).toBe(false)
})
it("retains old bytes on stale approvals, revoked ownership, wrong ciphertext or unavailable OS storage", () => {
  const f = fixture()
  f.values.saveSensitive(
    "w",
    "p",
    old,
    "private",
    { operation: "set", value: "hidden" },
    0,
    () => {}
  )
  const plan = f.values.migration("w", "p", schema, declaration)!,
    before = f.raw()
  expect(() =>
    f.values.migrate("w", "p", schema, declaration, 0, plan.view.digest, () => {})
  ).toThrow("MODS_CONFIG_VALUE_CHANGED")
  expect(() =>
    f.values.migrate("w", "p", schema, declaration, 1, "0".repeat(64), () => {})
  ).toThrow("MODS_USER_CONFIG_MIGRATION_CHANGED")
  expect(() =>
    f.values.migrate("w", "p", schema, declaration, 1, plan.view.digest, () => {
      throw Error("scope changed")
    })
  ).toThrow("scope changed")
  expect(f.raw()).toBe(before)
  const record = f.values.read("w", "p")
  record.sealed!.private = "ZmFrZQ=="
  f.set(JSON.stringify(record))
  expect(f.values.migration("w", "p", schema, declaration)!.view.canApply).toBe(false)
  expect(f.raw()).toContain("ZmFrZQ==")
})
it("rejects migration declarations without fields, ambiguous chains and incomplete record identity", () => {
  for (const value of [
    { version: 0, migrations: [] },
    {
      version: 1,
      migrations: [
        {
          fromVersion: 0,
          toVersion: 1,
          changes: [
            { kind: "rename", from: "old", to: "token" },
            { kind: "remove", key: "token" }
          ]
        }
      ]
    },
    { version: 1, migrations: [], execute: "arbitrary" }
  ])
    expect(() => parseFunctionUserConfigSchema(value, schema)).toThrow(
      "MODS_USER_CONFIG_MIGRATION_INVALID"
    )
  expect(() => parseFunctionUserConfigSchema({ version: 1, migrations: [] })).toThrow()
  const f = fixture()
  f.set('{"revision":1,"values":{},"schemaVersion":1}')
  expect(() => f.values.read("w", "p")).toThrow("MODS_USER_CONFIG_STORE")
})

it("an explicit sensitive removal keeps ciphertext until native confirmation and an unavailable OS backend blocks a secret rename", () => {
  const f = fixture()
  f.values.saveSensitive(
    "w",
    "p",
    old,
    "private",
    { operation: "set", value: "never-expose-removal" },
    0,
    () => {}
  )
  const removal = {
    version: 1,
    migrations: [
      { fromVersion: 0, toVersion: 1, changes: [{ kind: "remove" as const, key: "private" }] }
    ]
  }
  const plan = f.values.migration("w", "p", schema, removal)!,
    before = f.raw()
  expect(plan.view.canApply).toBe(true)
  expect(f.raw()).toBe(before)
  expect(() =>
    f.values.migrate("w", "p", schema, removal, 1, plan.view.digest, () => {
      throw Error("native cancelled")
    })
  ).toThrow("native cancelled")
  expect(f.raw()).toBe(before)
  f.protector.isEncryptionAvailable = () => false
  expect(f.values.migration("w", "p", schema, declaration)!.view.canApply).toBe(false)
  expect(f.raw()).toBe(before)
  // Removing a secret needs no decryption; the caller must still obtain explicit native confirmation.
  f.values.migrate("w", "p", schema, removal, 1, plan.view.digest, () => {})
  expect(f.values.read("w", "p").sealed).toBeUndefined()
  expect(f.values.read("w", "p").revision).toBe(2)
})
