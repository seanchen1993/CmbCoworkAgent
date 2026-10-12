import { afterEach, expect, it, vi } from "vitest"
import {
  discardCorruptComputerMaintenance,
  maintenancePending
} from "./bot-browser-maintenance-pending"

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const items = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => items.set(key, value),
    removeItem: (key: string) => items.delete(key)
  })
  return items
}
const nonce = "d06c827e-4d85-465b-a73d-c20c9c591e5a"
const otherNonce = "f319dcda-7533-40f4-8528-06260db716d7"
const checkpoint = { id: otherNonce, sha256: "a".repeat(64) }

it("keeps the same computer intent across restore epochs and protects it from a new intent", () => {
  const items = fixture()
  const first = maintenancePending("computer")
  const request = { action: "restore" as const, nonce, checkpoint }
  first.remember(request)
  const reopened = maintenancePending("computer")
  expect(reopened.pending()).toEqual(request)
  reopened.remember(request)
  expect(() => reopened.remember({ ...request, nonce: otherNonce })).toThrow("尚未确认")
  reopened.forget({ ...request, nonce: otherNonce })
  expect(reopened.pending()).toEqual(request)
  reopened.forget(request)
  expect(items.size).toBe(0)
})
it("keeps recovery-copy deletion separate and normalizes UUIDs for exact acknowledgements", () => {
  fixture()
  const store = maintenancePending("computer")
  store.remember({ action: "create", nonce: nonce.toUpperCase() })
  expect(store.pending()).toEqual({ action: "create", nonce })
  store.forget({ action: "create", nonce: nonce.toUpperCase() })
  store.remember({ action: "delete-recovery", checkpoint })
  expect(store.pending()).toEqual({ action: "delete-recovery", checkpoint })
  store.forget({ action: "delete", checkpoint })
  expect(store.pending()?.action).toBe("delete-recovery")
})
it("rejects corrupt or unavailable computer storage before dispatch and bounds accepted records", () => {
  const items = fixture()
  const store = maintenancePending("computer")
  const key = "cmb:bot-computer-maintenance:pending"
  for (const raw of [
    "{",
    "x".repeat(4097),
    JSON.stringify({ action: "reset", nonce }),
    JSON.stringify({ action: "create", nonce, extra: true })
  ]) {
    items.set(key, raw)
    expect(store.pending()).toBeNull()
    expect(() => store.remember({ action: "create", nonce })).toThrow("尚未提交")
  }
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota")
    }
  })
  expect(() => store.remember({ action: "create", nonce })).toThrow("尚未提交")
})
it("retains legacy browser and workspace keys and allows their reset contract", () => {
  const items = fixture()
  const request = { action: "reset" as const, nonce }
  maintenancePending("browser").remember(request)
  maintenancePending("workspace").remember(request)
  expect(maintenancePending("browser").pending()).toEqual(request)
  expect(maintenancePending("workspace").pending()).toEqual(request)
  expect(maintenancePending("computer").pending()).toBeNull()
  expect([...items.keys()]).toEqual([
    "cmb:bot-browser-maintenance:pending",
    "cmb:bot-workspace-maintenance:pending"
  ])
})
it("separates unreadable storage from corruption and clears only the exact preserved corrupt record", () => {
  const items = fixture()
  const key = "cmb:bot-computer-maintenance:pending"
  const store = maintenancePending("computer")
  items.set(key, "{")
  expect(store.inspect()).toEqual({ kind: "corrupt", raw: "{" })
  expect(discardCorruptComputerMaintenance("old")).toBe(false)
  items.set(key, JSON.stringify({ action: "create", nonce }))
  expect(discardCorruptComputerMaintenance("{")).toBe(false)
  expect(store.pending()).toEqual({ action: "create", nonce })
  items.set(key, "broken")
  expect(discardCorruptComputerMaintenance("broken")).toBe(true)
  expect(store.inspect()).toEqual({ kind: "empty" })
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied")
    },
    removeItem: vi.fn()
  })
  expect(store.inspect()).toEqual({ kind: "unreadable" })
  expect(() => discardCorruptComputerMaintenance("broken")).toThrow("原记录仍保留")
  expect(() => store.forget({ action: "create", nonce })).toThrow("原请求仍保留")
})
