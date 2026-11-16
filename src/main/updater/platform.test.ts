import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, () => unknown>(),
  send: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  installAsar: vi.fn(),
  installFull: vi.fn(),
  rollback: vi.fn(),
  isRollbackAvailable: vi.fn(),
  notify: vi.fn(),
  resolveUpdateSource: vi.fn()
}))

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: () => unknown) => mocks.handlers.set(channel, handler)
  },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))
vi.mock("./checker", () => ({ checkForUpdate: mocks.check }))
vi.mock("./downloader", () => ({ downloadUpdate: mocks.download }))
vi.mock("./installer", () => ({
  installAsarUpdate: mocks.installAsar,
  installFullUpdate: mocks.installFull
}))
vi.mock("./rollback", () => ({
  rollbackToPrevious: mocks.rollback,
  isRollbackAvailable: mocks.isRollbackAvailable
}))
vi.mock("../services/notify", () => ({ notifyAlways: mocks.notify }))
vi.mock("./channel-config", () => ({
  isSelfTestUpdateSource: () => false,
  resolveUpdateSource: mocks.resolveUpdateSource
}))
vi.mock("./logger", () => ({ updaterLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!

function invoke(channel: string): unknown {
  const handler = mocks.handlers.get(`update:${channel}`)
  if (!handler) throw new Error(`No IPC handler registered for ${channel}`)
  return handler()
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.handlers.clear()
  vi.stubEnv("VITE_UPDATE_SERVER_URL", "https://updates.example.com")
  mocks.resolveUpdateSource.mockReturnValue({
    channel: "production",
    baseUrl: "https://updates.example.com",
    manifestFile: "release.json"
  })
})

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor)
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("in-app update platform support", () => {
  it("keeps in-app updates idle on macOS and directs install actions to the DMG", async () => {
    const { registerUpdaterHandlers, startUpdateChecker } = await import("./index")
    Object.defineProperty(process, "platform", { value: "darwin" })

    registerUpdaterHandlers()
    startUpdateChecker()

    expect(vi.getTimerCount()).toBe(0)
    expect(invoke("check")).toEqual({ hasUpdate: false, source: null })
    expect(invoke("get-status")).toEqual({
      status: "idle",
      update: null,
      progress: null,
      errorMessage: null,
      canRollback: false,
      source: null
    })
    expect(invoke("dismiss")).toEqual({ success: true })
    for (const action of ["download", "install", "rollback"]) {
      expect(() => invoke(action)).toThrow("macOS DMG")
    }
    for (const operation of [
      mocks.resolveUpdateSource,
      mocks.check,
      mocks.download,
      mocks.send,
      mocks.notify,
      mocks.installAsar,
      mocks.installFull,
      mocks.isRollbackAvailable,
      mocks.rollback
    ]) {
      expect(operation).not.toHaveBeenCalled()
    }
  })

  it.each(["win32", "linux"])("still checks and downloads at startup on %s", async (platform) => {
    const { registerUpdaterHandlers, startUpdateChecker } = await import("./index")
    Object.defineProperty(process, "platform", { value: platform })
    mocks.check.mockResolvedValue({
      version: "1.5.1",
      targetVersion: "1.5.1",
      minVersion: "1.5.0",
      updateType: "asar",
      releaseNotes: "Release notes",
      mandatory: true,
      downloadFile: "app.asar.gz",
      downloadSha256: "sha256",
      downloadSize: 100,
      channel: "stable"
    })
    mocks.download.mockResolvedValue("downloaded.asar")

    registerUpdaterHandlers()
    startUpdateChecker()
    await vi.advanceTimersByTimeAsync(5000)

    expect(mocks.check).toHaveBeenCalledWith("https://updates.example.com", {
      manifestFile: "release.json"
    })
    expect(mocks.download).toHaveBeenCalledWith(
      "https://updates.example.com",
      "app.asar.gz",
      "sha256",
      100,
      expect.any(Function)
    )
    expect(mocks.send).toHaveBeenCalledWith(
      "update:downloaded",
      expect.objectContaining({ version: "1.5.1", mandatory: true })
    )
    await expect(invoke("check")).resolves.toMatchObject({
      hasUpdate: true,
      currentStatus: "downloaded"
    })
    await invoke("install")
    expect(mocks.installAsar).toHaveBeenCalledWith("downloaded.asar", "1.5.1")
  })
})
