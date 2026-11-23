import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserService } from "../browser/core/browser-service"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"

const f = vi.hoisted(() => ({
  enabled: true,
  exportCookies: vi.fn(),
  importData: vi.fn(),
  log: vi.fn(),
  registration: vi.fn()
}))
vi.mock("../storage", () => ({ getBrowserCdpConfig: () => ({ profileImportEnabled: f.enabled }) }))
vi.mock("../browser/chrome/browser-cookie-bridge-server", () => ({
  BrowserCookieBridgeServer: class {
    start = async () => {}
    stop = () => {}
    exportCookies = f.exportCookies
  }
}))
vi.mock("../browser/chrome/browser-native-host-installer", () => ({
  ensureCmbChromeNativeHostRegistration: f.registration
}))

const platform = Object.getOwnPropertyDescriptor(process, "platform")!
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  Object.defineProperty(process, "platform", { value: "win32" })
  f.enabled = true
  f.registration.mockResolvedValue({ nativeHostRegistered: true })
  f.exportCookies.mockResolvedValue({
    cookies: [
      { name: "auth", value: "synthetic", domain: ".example.test", path: "/", secure: true }
    ],
    skippedCookies: 0
  })
  f.importData.mockResolvedValue({ importedCookies: 1, skippedCookies: 0 })
})
afterEach(() => Object.defineProperty(process, "platform", platform))

async function setup() {
  const module = await import("./browser-profile-import")
  type Handler = Parameters<IpcMain["handle"]>[1]
  const handlers = new Map<string, Handler>()
  const service = {
    importProfileData: f.importData,
    appendConsoleEntry: f.log
  } as unknown as BrowserService
  module.registerBrowserProfileImportHandlers(
    {
      handle: (name: string, handler: Handler) => handlers.set(name, handler)
    } as unknown as IpcMain,
    () => ({ isDestroyed: () => false, webContents: { id: 7 } }) as BrowserWindow,
    service
  )
  return {
    module,
    service,
    invoke: (senderId = 7, autoImport = true) =>
      handlers.get("browser:importProfileData")!(
        { sender: { id: senderId } } as IpcMainInvokeEvent,
        { sourceBrowser: "chrome", autoImport }
      )
  }
}

describe("shared Bot/workbench Chrome import", () => {
  it("coalesces headless Bot startup and workbench auto-import into one extension request", async () => {
    const { module, service, invoke } = await setup()
    const results = await Promise.all([
      module.ensureBrowserProfileAutoImport(service),
      invoke(),
      module.ensureBrowserProfileAutoImport(service)
    ])
    expect(results[1]).toMatchObject({
      success: true,
      importedCookies: 1,
      importMethod: "extension"
    })
    expect(f.exportCookies).toHaveBeenCalledExactlyOnceWith(5000)
    expect(f.importData).toHaveBeenCalledOnce()
    expect(f.importData.mock.calls[0][0].cookies[0].value).toBe("synthetic")
    expect(JSON.stringify(f.log.mock.calls)).not.toContain("synthetic")
    await invoke(7, false)
    expect(f.exportCookies).toHaveBeenCalledTimes(2)
  })

  it("does not access Chrome when import is disabled and still rejects foreign windows", async () => {
    f.enabled = false
    const { module, service, invoke } = await setup()
    await module.ensureBrowserProfileAutoImport(service)
    expect((await invoke()).success).toBe(false)
    expect(f.exportCookies).not.toHaveBeenCalled()
    expect((await invoke(99)).error).toContain("未知窗口")
  })

  it("keeps a failed automatic import retryable through the existing manual entry", async () => {
    const { module, service, invoke } = await setup()
    f.exportCookies.mockRejectedValueOnce(
      Object.assign(new Error("extension unavailable"), { code: "extension_not_connected" })
    )
    await module.ensureBrowserProfileAutoImport(service)
    expect((await invoke()).errorCode).toBe("extension_not_connected")
    expect(f.exportCookies).toHaveBeenCalledTimes(1)
    expect((await invoke(7, false)).success).toBe(true)
    expect(f.exportCookies).toHaveBeenCalledTimes(2)
  })
})
