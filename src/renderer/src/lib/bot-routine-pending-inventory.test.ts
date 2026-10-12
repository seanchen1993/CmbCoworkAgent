import { afterEach, expect, it, vi } from "vitest"
import { pendingRoutineOperations } from "./bot-routine-pending-inventory"

function fixture(keys: string[]) {
  const readBody = vi.fn(() => {
    throw new Error("Inventory must not read request bodies")
  })
  vi.stubGlobal("localStorage", {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
    getItem: readBody
  })
  return readBody
}
afterEach(() => vi.unstubAllGlobals())
it("indexes disappeared save and manual-run identities separately without reading any request bodies", () => {
  const readBody = fixture([
    "bot-routine-pending:owner:new",
    "bot-routine-pending:owner:gone",
    "bot-routine-run-pending:owner:gone",
    "bot-routine-pending:other:foreign",
    "bot-routine-run-pending:other:foreign",
    "bot-skill-save-pending:owner:skill",
    "unrelated"
  ])
  expect(pendingRoutineOperations("owner")).toEqual([
    { kind: "save", id: "gone" },
    { kind: "run", id: "gone" }
  ])
  expect(pendingRoutineOperations("other")).toEqual([
    { kind: "save", id: "foreign" },
    { kind: "run", id: "foreign" }
  ])
  expect(readBody).not.toHaveBeenCalled()
})
it("accepts at most 64 lightweight identities and surfaces overflow instead of hiding original requests", () => {
  const keys = Array.from({ length: 64 }, (_, index) => `bot-routine-pending:owner:gone-${index}`)
  fixture(keys)
  expect(pendingRoutineOperations("owner")).toHaveLength(64)
  fixture([...keys, "bot-routine-run-pending:owner:gone-0"])
  expect(() => pendingRoutineOperations("owner")).toThrow("待核对例程操作过多")
  fixture(Array.from({ length: 4097 }, (_, index) => `other:${index}`))
  expect(() => pendingRoutineOperations("owner")).toThrow("本机操作记录过多")
})
it("reports unreadable storage and malformed own indices without reading or removing the original raw values", () => {
  for (const suffix of ["", "invalid id", "a".repeat(161)]) {
    fixture([`bot-routine-pending:owner:${suffix}`])
    expect(() => pendingRoutineOperations("owner")).toThrow("索引无法读取")
  }
  vi.stubGlobal("localStorage", {
    get length() {
      throw new Error("storage denied")
    }
  })
  expect(() => pendingRoutineOperations("owner")).toThrow("storage denied")
  vi.stubGlobal("localStorage", {
    length: 1,
    key: () => {
      throw new Error("key denied")
    }
  })
  expect(() => pendingRoutineOperations("owner")).toThrow("key denied")
})
