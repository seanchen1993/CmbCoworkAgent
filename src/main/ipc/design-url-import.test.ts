import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  prepareForEditing: vi.fn(),
  cancelOwner: vi.fn(),
  contents: { getURL: vi.fn(), executeJavaScript: vi.fn() },
  browser: {
    prepareTarget: vi.fn(),
    requestPanel: vi.fn(),
    navigate: vi.fn(),
    getWebContents: vi.fn()
  }
}))
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock("../browser/core/browser-service-registry", () => ({
  getGlobalBrowserService: () => mocks.browser
}))
vi.mock("../services/design/url-import-service", () => ({
  DesignUrlImportService: class {
    prepareForEditing = mocks.prepareForEditing
    cancelOwner = mocks.cancelOwner
  }
}))

import { registerDesignUrlImportHandlers } from "./design-url-import"

describe("design browser opening", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    registerDesignUrlImportHandlers(() => "/workspace")
    mocks.browser.getWebContents.mockReturnValue(mocks.contents)
    mocks.contents.getURL.mockReturnValue("https://example.com/page")
    mocks.contents.executeJavaScript.mockResolvedValue({ recording: true, count: 0 })
  })

  it("starts recording in the current browser and clears it when the owning renderer closes", async () => {
    const sender = { id: 17, once: vi.fn(), on: vi.fn() }
    const control = mocks.handlers.get("design:control-import-interactions")!
    expect(await control({ sender }, "start")).toEqual({ recording: true, count: 0 })
    expect(mocks.contents.executeJavaScript.mock.calls[0][0]).toContain(')("start")')
    const destroyed = sender.once.mock.calls.find(([event]) => event === "destroyed")![1]
    destroyed()
    expect(mocks.contents.executeJavaScript.mock.calls.at(-1)![0]).toContain(')("clear")')
    expect(mocks.cancelOwner).toHaveBeenCalledWith(17)
  })

  it("does not let an old confirmation clear a newer renderer's recording", async () => {
    const control = mocks.handlers.get("design:control-import-interactions")!
    const sender = (id: number) => ({ id, once: vi.fn(), on: vi.fn() })
    await control({ sender: sender(17) }, "start")
    await control({ sender: sender(18) }, "start")
    expect(await control({ sender: sender(17) }, "clear")).toEqual({ recording: false, count: 0 })
    expect(mocks.contents.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it("requires an HTTP page to start recording", async () => {
    mocks.contents.getURL.mockReturnValue("about:blank")
    const sender = { id: 17, once: vi.fn(), on: vi.fn() }
    await expect(
      mocks.handlers.get("design:control-import-interactions")!({ sender }, "start")
    ).rejects.toThrow("请先在内置浏览器打开目标页面")
    expect(mocks.contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it("prepares an editing copy owned by the requesting renderer", async () => {
    mocks.prepareForEditing.mockResolvedValue({
      success: true,
      artifactPath: "/workspace/.cmb-design/ds_1234abcd_design-main/index.html"
    })
    const result = await mocks.handlers.get("design:prepare-url-import-for-editing")!(
      { sender: { id: 17 } },
      "capture-test",
      "ds_1234abcd"
    )
    expect(result).toMatchObject({ success: true })
    expect(mocks.prepareForEditing).toHaveBeenCalledWith(17, "capture-test", "ds_1234abcd")
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
