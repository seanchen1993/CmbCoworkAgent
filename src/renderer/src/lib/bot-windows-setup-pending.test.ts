import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  readWindowsSetupPending,
  rememberWindowsSetupPending,
  forgetWindowsSetupPending,
  discardCorruptWindowsSetupPending
} from "./bot-windows-setup-pending"
const request = { nonce: "023ec054-fd96-4a28-b00c-aa89b9d8d67d", scope: "a".repeat(64) },
  values = new Map<string, string>()
beforeEach(() => {
  values.clear()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  })
})
afterEach(() => vi.unstubAllGlobals())
it("keeps exactly one bounded nonce across setting reopen and only clears its matching acknowledged result", () => {
  expect(readWindowsSetupPending()).toEqual({ request: null, corrupt: false })
  rememberWindowsSetupPending(request)
  expect(readWindowsSetupPending()).toEqual({ request, corrupt: false })
  expect(() =>
    forgetWindowsSetupPending({ ...request, nonce: "123ec054-fd96-4a28-b00c-aa89b9d8d67d" })
  ).toThrow("记录已变化")
  expect(readWindowsSetupPending().request).toEqual(request)
  expect(() =>
    rememberWindowsSetupPending({ ...request, nonce: "123ec054-fd96-4a28-b00c-aa89b9d8d67d" })
  ).toThrow("原请求")
  forgetWindowsSetupPending(request)
  expect(readWindowsSetupPending().request).toBeNull()
})
it("rejects storage failure before sending and preserves corrupted/oversize bytes until explicit discard", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {
      throw new Error("storage unavailable")
    }
  })
  expect(() => rememberWindowsSetupPending(request)).toThrow("storage unavailable")
  vi.stubGlobal("localStorage", { getItem: () => "x".repeat(1025), removeItem: vi.fn() })
  expect(readWindowsSetupPending()).toEqual({ request: null, corrupt: true })
  expect(() => forgetWindowsSetupPending(request)).toThrow("记录已变化")
  expect(localStorage.removeItem).not.toHaveBeenCalled()
  discardCorruptWindowsSetupPending()
  expect(localStorage.removeItem).toHaveBeenCalledTimes(1)
})
