import { beforeEach, describe, expect, it, vi } from "vitest"

const settings = vi.hoisted(() => new Map<string, unknown>())

vi.mock("electron", () => ({ app: {} }))
vi.mock("electron-store", () => ({
  default: class {
    get(key: string) { return settings.get(key) }
    set(key: string, value: unknown) { settings.set(key, value) }
  }
}))

import { getStartupView, setStartupView } from "./storage"

describe("stored startup destination", () => {
  beforeEach(() => settings.clear())

  it("defaults existing installations and invalid stored values to the workbench", () => {
    expect(getStartupView()).toBe("thread")
    for (const value of [null, true, "harness", { view: "bots" }]) {
      settings.set("startupView", value)
      expect(getStartupView()).toBe("thread")
    }
  })

  it("persists the explicit choice in the existing settings store", () => {
    expect(setStartupView("bots")).toBe("bots")
    expect(getStartupView()).toBe("bots")
    expect(setStartupView("thread")).toBe("thread")
    expect(getStartupView()).toBe("thread")
  })

  it("rejects unknown destinations without replacing the saved value", () => {
    setStartupView("bots")
    expect(() => setStartupView("customize")).toThrow("Invalid startup view")
    expect(getStartupView()).toBe("bots")
  })
})
