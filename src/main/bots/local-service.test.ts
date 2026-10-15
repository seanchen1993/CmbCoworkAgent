import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  stop: vi.fn(),
  browserClose: vi.fn(),
  memoryClose: vi.fn(),
  summaryClose: vi.fn(),
  databaseClose: vi.fn(),
  trace: [] as string[]
}))
vi.mock("../db", () => ({ getThreadCore: vi.fn() }))
vi.mock("../agent/pending-notification-scheduler", () => ({
  pendingNotificationScheduler: { setManagedDispatcher: vi.fn() }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => "/synthetic-test" }))
vi.mock("../db/native-sqlite-adapter", () => ({
  openNativeSqliteDatabase: () => ({ database: { close: fixture.databaseClose } })
}))
vi.mock("./store", () => ({ BotStore: class {} }))
vi.mock("./host", () => ({
  LocalBotHost: class {
    stop = fixture.stop
  }
}))
vi.mock("./runtime-adapter", () => ({ createLocalBotRunPort: vi.fn() }))
vi.mock("./memory", () => ({
  BotMemoryService: class {
    close = fixture.memoryClose
  }
}))
vi.mock("./browser", () => ({
  BotBrowserService: class {
    close = fixture.browserClose
  }
}))
vi.mock("./electron-browser-engine", () => ({ startElectronBotBrowser: vi.fn() }))
vi.mock("./memory-summary-adapter", () => ({
  createBotMemoryMaintainer: () => ({ close: fixture.summaryClose })
}))
vi.mock("../storage", () => ({ computeNextRunAt: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  fixture.trace = []
  fixture.browserClose.mockImplementation(async () => {
    fixture.trace.push("browser")
  })
  fixture.summaryClose.mockImplementation(async () => {
    fixture.trace.push("summary")
  })
  fixture.memoryClose.mockImplementation(async () => {
    fixture.trace.push("memory")
  })
  fixture.databaseClose.mockImplementation(() => {
    fixture.trace.push("database")
  })
})

describe("Bot local service shutdown", () => {
  it("drains the host before closing resources, shares a single shutdown, and fences late IPC", async () => {
    let release!: () => void
    fixture.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const service = await import("./local-service")
    service.getLocalBotHost()
    const first = service.stopLocalBotHost()
    expect(service.stopLocalBotHost()).toBe(first)
    expect(() => service.getLocalBotHost()).toThrow("退出")
    await Promise.resolve()
    expect(fixture.databaseClose).not.toHaveBeenCalled()
    expect(fixture.browserClose).not.toHaveBeenCalled()
    release()
    await first
    expect(fixture.trace.slice(0, 2).sort()).toEqual(["browser", "summary"])
    expect(fixture.trace.slice(2)).toEqual(["memory", "database"])
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    expect(() => service.getLocalBotHost()).toThrow("退出")
  })

  it("still closes independent resources after one close fails", async () => {
    fixture.browserClose.mockRejectedValue(new Error("browser cleanup failed"))
    const service = await import("./local-service")
    service.getLocalBotHost()
    await expect(service.stopLocalBotHost()).rejects.toThrow("退出清理")
    expect(fixture.summaryClose).toHaveBeenCalledTimes(1)
    expect(fixture.memoryClose).toHaveBeenCalledTimes(1)
    expect(fixture.databaseClose).toHaveBeenCalledTimes(1)
  })
})
