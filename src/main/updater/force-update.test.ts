import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UpdateCheckResult } from "./checker"

type IpcHandler = (...args: unknown[]) => unknown

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  events: [] as Array<{ channel: string; data: unknown }>,
  checkResult: null as UpdateCheckResult | null,
  downloadCalls: [] as unknown[][],
  pendingDownload: null as Promise<string> | null
}))

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      mockState.handlers.set(channel, handler)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, data: unknown) => {
            mockState.events.push({ channel, data })
          }
        }
      }
    ]
  }
}))

vi.mock("./checker", () => ({
  checkForUpdate: vi.fn(async () => mockState.checkResult)
}))

vi.mock("./downloader", () => ({
  downloadUpdate: vi.fn(async (...args: unknown[]) => {
    mockState.downloadCalls.push(args)
    return mockState.pendingDownload ?? new Promise<string>(() => {})
  })
}))

vi.mock("./installer", () => ({
  installAsarUpdate: vi.fn(),
  installFullUpdate: vi.fn()
}))

vi.mock("./rollback", () => ({
  rollbackToPrevious: vi.fn(),
  isRollbackAvailable: vi.fn(() => false)
}))

vi.mock("../services/notify", () => ({
  notifyAlways: vi.fn()
}))

import { registerUpdaterHandlers } from "./index"

function makeMandatoryUpdate(): UpdateCheckResult {
  return {
    version: "1.4.7",
    targetVersion: "1.4.7",
    minVersion: "1.4.5",
    updateType: "asar",
    releaseNotes: "force update",
    mandatory: true,
    downloadFile: "app.asar.gz",
    downloadSha256: "sha256",
    downloadSize: 1024,
    channel: "stable",
    grayReason: "no-staging"
  }
}

describe("force update IPC behavior", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_UPDATE_SERVER_URL", "http://updates.example.test")
    mockState.handlers.clear()
    mockState.events = []
    mockState.downloadCalls = []
    mockState.pendingDownload = new Promise<string>(() => {})
    mockState.checkResult = makeMandatoryUpdate()
    registerUpdaterHandlers()
  })

  it("auto-starts manual mandatory downloads and refuses dismissal", async () => {
    const check = mockState.handlers.get("update:check")
    const dismiss = mockState.handlers.get("update:dismiss")
    const getStatus = mockState.handlers.get("update:get-status")

    expect(check).toBeDefined()
    expect(dismiss).toBeDefined()
    expect(getStatus).toBeDefined()

    const result = await check!()

    expect(result).toMatchObject({
      hasUpdate: true,
      version: "1.4.7",
      mandatory: true,
      currentStatus: "downloading"
    })
    expect(mockState.downloadCalls).toHaveLength(1)
    expect(mockState.events.find((event) => event.channel === "update:available")?.data).toMatchObject({
      mandatory: true,
      autoDownloading: true
    })

    await expect(dismiss!()).rejects.toThrow("强制更新不可忽略")
    await expect(getStatus!()).resolves.toMatchObject({
      status: "downloading",
      update: {
        version: "1.4.7",
        mandatory: true
      }
    })
  })
})
