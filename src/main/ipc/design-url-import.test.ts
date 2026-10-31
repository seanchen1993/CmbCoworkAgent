import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  browser: {
    prepareTarget: vi.fn(),
    requestPanel: vi.fn(),
    navigate: vi.fn()
  }
}))
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock("../browser/core/browser-service-registry", () => ({
  getGlobalBrowserService: () => mocks.browser
}))
vi.mock("../services/design/url-import-service", () => ({ DesignUrlImportService: class {} }))

import { registerDesignUrlImportHandlers } from "./design-url-import"

describe("design browser opening", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    registerDesignUrlImportHandlers(() => "/workspace")
  })

  it("keeps late target preparation from reopening a panel that the user closed", async () => {
    let finishPreparation!: () => void
    let visible = false
    mocks.browser.prepareTarget.mockImplementation(async (options: { visible: boolean }) => {
      visible = options.visible
      await new Promise<void>((resolve) => {
        finishPreparation = resolve
      })
    })
    mocks.browser.requestPanel.mockImplementation(() => {
      visible = true
    })
    mocks.browser.navigate.mockResolvedValue({ url: "https://example.com/page" })
    const pending = mocks.handlers.get("design:open-import-browser")!(
      {},
      "https://example.com/page"
    )
    expect(visible).toBe(false)
    // The panel is closed while the native target is still initializing.
    visible = false
    finishPreparation()
    expect(await pending).toEqual({ success: true })
    expect(visible).toBe(false)
    expect(mocks.browser.requestPanel).not.toHaveBeenCalled()
    expect(mocks.browser.navigate).toHaveBeenCalledWith("https://example.com/page")
  })
})
