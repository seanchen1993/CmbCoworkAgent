import { describe, expect, it, vi } from "vitest"
import { showBotBrowserWindow } from "./browser-window-focus"

describe("Bot browser foreground handoff", () => {
  const fixture = (pinned = false) => {
    const calls: string[] = []
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      isAlwaysOnTop: () => pinned,
      restore: () => calls.push("restore"),
      setAlwaysOnTop: (value: boolean) => calls.push(`top:${value}`),
      show: () => calls.push("show"),
      moveTop: () => calls.push("raise"),
      focus: vi.fn(() => {
        calls.push("focus")
      }),
      webContents: { focus: () => calls.push("page-focus") }
    }
    return {
      calls,
      window,
      native: window as unknown as Parameters<typeof showBotBrowserWindow>[0]
    }
  }
  it("restores and raises a minimized Windows window without keeping it always on top", () => {
    const f = fixture()
    showBotBrowserWindow(f.native, "win32")
    expect(f.calls).toEqual([
      "restore",
      "top:true",
      "show",
      "raise",
      "focus",
      "page-focus",
      "top:false"
    ])
  })
  it("restores the original topmost state even if focusing fails", () => {
    const f = fixture()
    f.window.focus.mockImplementation(() => {
      throw new Error("closed")
    })
    expect(() => showBotBrowserWindow(f.native, "win32")).toThrow("closed")
    expect(f.calls.at(-1)).toBe("top:false")
  })
  it("preserves an existing topmost preference and does not change macOS window levels", () => {
    for (const platform of ["win32", "darwin"] as const) {
      const f = fixture(platform === "win32")
      showBotBrowserWindow(f.native, platform)
      expect(f.calls).toEqual(["restore", "show", "raise", "focus", "page-focus"])
    }
  })
})
