import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it } from "vitest"
import { FunctionStateStore } from "./state-store"

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  return new FunctionStateStore(db)
}

it("keeps unset distinct from null, JSON isolation and insertion order through updates", () => {
  const store = fixture()
  expect(store.get("a", "unset")).toBeUndefined()
  store.set("a", "空键", null)
  store.set("a", "__proto__", { count: 1 })
  store.set("a", "", "empty key")
  store.set("a", "空键", [2])
  expect(store.keys("a")).toEqual(["空键", "__proto__", ""])
  expect(store.get("b", "__proto__")).toBeUndefined()
  const value = store.get("a", "__proto__") as { count: number }
  value.count = 99
  expect(store.get("a", "__proto__")).toEqual({ count: 1 })
  store.delete("a", "空键")
  store.set("a", "空键", null)
  expect(store.keys("a")).toEqual(["__proto__", "", "空键"])
  expect(store.get("a", "空键")).toBeNull()
})

it("rolls back a write over the 4 MiB plugin quota without damaging existing entries", () => {
  const store = fixture()
  const value = "x".repeat(900000)
  for (const key of ["a", "b", "c", "d"]) store.set("plugin", key, value)
  expect(() => store.set("plugin", "overflow", value)).toThrow("MODS_STORE_QUOTA")
  expect(store.keys("plugin")).toEqual(["a", "b", "c", "d"])
  expect(store.get("plugin", "a")).toBe(value)
  store.set("plugin", "a", "small")
  store.set("plugin", "fits", value)
  expect(store.keys("plugin")).toEqual(["a", "b", "c", "d", "fits"])
})

it("preserves valid Unicode keys and rejects names SQLite would silently replace", () => {
  const store = fixture()
  store.set("plugin", '偏好🦀"', 1)
  expect(store.get("plugin", '偏好🦀"')).toBe(1)
  expect(() => store.set("plugin", "\ud800", 2)).toThrow("MODS_STORE_KEY")
  expect(() => store.set("plugin", "中".repeat(1366), 2)).toThrow("MODS_STORE_KEY")
  expect(store.keys("plugin")).toEqual(['偏好🦀"'])
})
