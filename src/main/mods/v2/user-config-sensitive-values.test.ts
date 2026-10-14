import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { parseFunctionUserConfig } from "../../../shared/mods/v2/user-config"
import { FunctionUserConfigValues } from "./user-config-values"
import { testSecretProtector } from "../../../../tests/support/mods-secret-protector"
import type { FunctionConfigValue } from "../../../shared/mods/v2/config"

const schema = parseFunctionUserConfig({
  token: { type: "string", sensitive: true, title: "Token", description: "Help", required: true },
  second: {
    type: "string",
    sensitive: true,
    title: "Second",
    description: "Help",
    default: "author-default"
  },
  flag: { type: "boolean", sensitive: true, title: "Flag", description: "Help" },
  number: { type: "number", sensitive: true, title: "Number", description: "Help" },
  list: {
    type: "string",
    sensitive: true,
    multiple: true,
    title: "List",
    description: "Help",
    required: true
  },
  ordinary: { type: "string", title: "Ordinary", description: "Help", default: "old" }
})!
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-secret-values-")),
    path = join(root, "control.sqlite")
  const protector = testSecretProtector()
  let store = new ModControlStore(path)
  cleanup.push(() => {
    store.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-secret-values-")
    )
      throw Error("Unexpected cleanup")
    rmSync(root, { recursive: true, force: true })
  })
  let values = new FunctionUserConfigValues(store, protector)
  const key = "function-user-config:" + JSON.stringify(["w", "p"])
  return {
    protector,
    get values() {
      return values
    },
    raw: () => store.getSetting(key, ""),
    setRaw: (raw: string) => store.setSetting(key, raw),
    store: () => store,
    reopen: () => {
      store.close()
      store = new ModControlStore(path)
      values = new FunctionUserConfigValues(store, protector)
    }
  }
}

it("an explicit save removes only obsolete secret fields so a full old schema can migrate", () => {
  const f = fixture()
  const old = parseFunctionUserConfig(
    Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        "old" + index,
        { type: "string", sensitive: true, title: "Old", description: "Help" }
      ])
    )
  )!
  for (let index = 0; index < 64; index++)
    f.values.saveSensitive(
      "w",
      "p",
      old,
      "old" + index,
      { operation: "set", value: "private-old-" + index },
      index,
      () => {}
    )
  expect(Object.keys(f.values.read("w", "p").sealed!)).toHaveLength(64)
  const next = { token: schema.token, old0: old.old0, old1: { ...old.old1, sensitive: false } }
  const retained = f.values.read("w", "p").sealed!.old0
  f.values.saveSensitive(
    "w",
    "p",
    next,
    "token",
    { operation: "set", value: "new-private" },
    64,
    () => {}
  )
  expect(Object.keys(f.values.read("w", "p").sealed!).sort()).toEqual(["old0", "token"])
  expect(f.values.read("w", "p").sealed!.old0).toBe(retained)
  expect(f.values.resolve("w", "p", next)).toEqual({
    token: "new-private",
    old0: "private-old-0",
    old1: ""
  })
  f.reopen()
  expect(f.values.resolve("w", "p", next).token).toBe("new-private")
})

it("malformed old plaintext records never expose their contents through error diagnostics", () => {
  const f = fixture()
  f.setRaw('private-malformed-sentinel{"revision":0,"values":{"token":"old-private"}}')
  for (const read of [
    () => f.values.read("w", "p"),
    () => f.values.presence("w", "p", schema, "token"),
    () => f.values.saveSensitive("w", "p", schema, "token", { operation: "clear" }, 0, () => {})
  ]) {
    expect(read).toThrow("MODS_USER_CONFIG_STORE")
    try {
      read()
    } catch (error) {
      expect(String(error)).not.toMatch(/sentinel|old-private/)
    }
  }
  expect(f.raw()).toContain("private-malformed-sentinel")
})

it("stores opaque per-field ciphertext in one revision, preserves other secrets and survives real SQLite reopening", () => {
  const f = fixture()
  f.values.saveSensitive(
    "w",
    "p",
    schema,
    "token",
    { operation: "set", value: "first-private" },
    0,
    () => {}
  )
  const firstCipher = f.values.read("w", "p").sealed!.token
  f.values.saveSensitive(
    "w",
    "p",
    schema,
    "second",
    { operation: "set", value: "second-private" },
    1,
    () => {}
  )
  expect(f.values.read("w", "p").sealed?.token).toBe(firstCipher)
  expect(f.raw()).not.toMatch(/first-private|second-private/)
  expect(f.values.presence("w", "p", schema, "token")).toEqual({ editable: true, state: "saved" })
  f.reopen()
  expect(f.values.resolve("w", "p", { token: schema.token, second: schema.second })).toEqual({
    token: "first-private",
    second: "second-private"
  })
  const offline = new FunctionUserConfigValues(f.store())
  const opaque = f.values.read("w", "p").sealed
  offline.save("w", "p", schema, "ordinary", "new", 2, () => {})
  expect(offline.read("w", "p").sealed).toEqual(opaque)
  expect(offline.presence("w", "p", schema, "token").state).toBe("unavailable")
  expect(() => offline.resolve("w", "p", { token: schema.token })).toThrow(
    "MODS_SECRET_STORAGE_UNAVAILABLE"
  )
})

it("keeps false, zero and empty arrays as set values and clear restores the original default/unset rules", () => {
  const f = fixture()
  const actualValues: Array<[string, FunctionConfigValue]> = [
    ["flag", false],
    ["number", 0],
    ["list", []]
  ]
  for (const [index, [key, value]] of actualValues.entries())
    f.values.saveSensitive(
      "w",
      "p",
      schema,
      key,
      { operation: "set", value: structuredClone(value) },
      index,
      () => {}
    )
  expect(
    f.values.resolve("w", "p", { flag: schema.flag, number: schema.number, list: schema.list })
  ).toEqual({ flag: false, number: 0, list: [] })
  f.values.saveSensitive(
    "w",
    "p",
    schema,
    "second",
    { operation: "set", value: "new" },
    3,
    () => {}
  )
  f.values.saveSensitive("w", "p", schema, "second", { operation: "clear" }, 4, () => {})
  expect(f.values.resolve("w", "p", { second: schema.second })).toEqual({
    second: "author-default"
  })
  f.values.saveSensitive("w", "p", schema, "list", { operation: "clear" }, 5, () => {})
  expect(() => f.values.resolve("w", "p", { list: schema.list })).toThrow("list")
  expect(f.values.resolve("w", "p", { token: { ...schema.token, required: false } })).toEqual({
    token: ""
  })
})

it("rejects copied and invalid fields while a safe explicit clear can recover just the damaged field", () => {
  const f = fixture()
  f.values.saveSensitive(
    "w",
    "p",
    schema,
    "token",
    { operation: "set", value: "first-private" },
    0,
    () => {}
  )
  const record = f.values.read("w", "p")
  f.setRaw(JSON.stringify({ ...record, sealed: { token: "broken" } }))
  expect(f.values.presence("w", "p", schema, "token").state).toBe("invalid")
  expect(() => f.values.resolve("w", "p", { token: schema.token })).toThrow(
    "MODS_SECRET_STORAGE_INVALID"
  )
  f.values.saveSensitive("w", "p", schema, "token", { operation: "clear" }, 1, () => {})
  expect(f.values.presence("w", "p", schema, "token").state).toBe("unset")
  f.setRaw(JSON.stringify(record))
  f.store().setSetting(
    "function-user-config:" + JSON.stringify(["other", "p"]),
    JSON.stringify(record)
  )
  expect(() => f.values.resolve("other", "p", { token: schema.token })).toThrow(
    "MODS_SECRET_STORAGE_INVALID"
  )
  f.setRaw("broken record")
  expect(() =>
    f.values.saveSensitive("w", "p", schema, "token", { operation: "clear" }, 1, () => {})
  ).toThrow()
})

it("does not inherit plaintext or revive old ciphertext across sensitive/ordinary schema changes", () => {
  const f = fixture()
  f.setRaw('{"revision":0,"values":{"token":"legacy-plaintext"}}')
  expect(f.values.presence("w", "p", schema, "token").state).toBe("unset")
  expect(() => f.values.resolve("w", "p", { token: schema.token })).toThrow("token")
  f.values.save("w", "p", schema, "ordinary", "new", 0, () => {})
  expect(f.raw()).not.toContain("legacy-plaintext")
  f.values.saveSensitive(
    "w",
    "p",
    schema,
    "token",
    { operation: "set", value: "private" },
    1,
    () => {}
  )
  const ordinarySchema = { token: { ...schema.token, sensitive: false, required: false } }
  expect(f.values.resolve("w", "p", ordinarySchema)).toEqual({ token: "" })
  f.values.save("w", "p", ordinarySchema, "token", "ordinary", 2, () => {})
  expect(f.values.read("w", "p").sealed).toBeUndefined()
  expect(() => f.values.resolve("w", "p", { token: schema.token })).toThrow("token")
})

it("rechecks owner and revision after real encryption and contains failed encryption without writes", () => {
  const f = fixture(),
    encrypt = f.protector.encryptString
  let owner = true
  f.protector.encryptString = (value) => {
    const result = encrypt(value)
    owner = false
    return result
  }
  expect(() =>
    f.values.saveSensitive(
      "w",
      "p",
      schema,
      "token",
      { operation: "set", value: "private" },
      0,
      () => {
        if (!owner) throw Error("owner changed")
      }
    )
  ).toThrow("owner changed")
  expect(f.values.read("w", "p")).toEqual({ revision: 0, values: {} })
  f.protector.encryptString = vi.fn(() => {
    throw Error("private")
  })
  expect(() =>
    f.values.saveSensitive(
      "w",
      "p",
      schema,
      "token",
      { operation: "set", value: "private" },
      0,
      () => {}
    )
  ).toThrow(/^MODS_SECRET_STORAGE_FAILED$/)
  expect(f.values.read("w", "p")).toEqual({ revision: 0, values: {} })
})
