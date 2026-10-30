import { beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))

vi.mock("electron", () => ({ app: {} }))
vi.mock("./app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => "/tmp" }))
vi.mock("electron-store", () => ({
  default: class {
    get(key: string): unknown {
      return settings.get(key)
    }

    set(key: string, value: unknown): void {
      settings.set(key, value)
    }
  }
}))

describe("stored shared vision role", () => {
  beforeEach(() => {
    settings.get.mockReset()
    settings.set.mockReset()
    vi.resetModules()
  })

  it("keeps old, corrupt or unreadable settings disabled", async () => {
    const { getStoredVisionModelRef } = await import("./storage")
    for (const value of [undefined, null, {}, false, 123, ""]) {
      settings.get.mockReturnValue(value)
      expect(getStoredVisionModelRef()).toBe("")
    }
    settings.get.mockImplementation(() => {
      throw new Error("settings unreadable")
    })
    expect(getStoredVisionModelRef()).toBe("")
  })

  it("persists only the selected model reference separately from chat settings", async () => {
    const { getStoredVisionModelRef, setStoredVisionModelRef } = await import("./storage")
    setStoredVisionModelRef(" custom:vision ")
    expect(settings.set).toHaveBeenCalledExactlyOnceWith("visionModelRef", "custom:vision")
    settings.get.mockReturnValue(" custom:vision ")
    expect(getStoredVisionModelRef()).toBe("custom:vision")
    setStoredVisionModelRef("")
    expect(settings.set).toHaveBeenLastCalledWith("visionModelRef", "")
  })

  it("propagates persistence failure and rejects invalid input", async () => {
    const { setStoredVisionModelRef } = await import("./storage")
    expect(() => setStoredVisionModelRef(null as unknown as string)).toThrow("引用必须是字符串")
    expect(settings.set).not.toHaveBeenCalled()
    settings.set.mockImplementation(() => {
      throw new Error("disk full")
    })
    expect(() => setStoredVisionModelRef("custom:vision")).toThrow("disk full")
  })
})
