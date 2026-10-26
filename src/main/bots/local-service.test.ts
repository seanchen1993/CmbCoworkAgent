import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const fixture = vi.hoisted(() => ({
  stop: vi.fn(),
  browserClose: vi.fn(),
  memoryClose: vi.fn(),
  memoryChanged: vi.fn(),
  hasActiveRuns: vi.fn(),
  notifyMemory: undefined as ((botId: string) => void) | undefined,
  summaryClose: vi.fn(),
  databaseClose: vi.fn(),
  getThread: vi.fn(),
  getMessages: vi.fn(),
  getFollowingMessages: vi.fn(),
  readReply: undefined as ((...args: unknown[]) => unknown) | undefined,
  readReactions: undefined as ((...args: unknown[]) => unknown) | undefined,
  removeReactions: vi.fn(),
  openDatabase: vi.fn(),
  dataRoot: "/synthetic-test",
  trace: [] as string[]
}))
vi.mock("../db", () => ({
  getThreadCore: fixture.getThread,
  getThreadMessagesByIds: fixture.getMessages,
  getThreadMessagesAfterAnyId: fixture.getFollowingMessages
}))
vi.mock("../agent/pending-notification-scheduler", () => ({
  pendingNotificationScheduler: { setManagedDispatcher: vi.fn() }
}))
vi.mock("../app-data-root", () => ({ getCmbCoworkAgentDataRoot: () => fixture.dataRoot }))
vi.mock("../db/native-sqlite-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/native-sqlite-adapter")>()),
  openNativeSqliteDatabase: fixture.openDatabase
}))
vi.mock("./store", () => ({
  BotStore: class {
    constructor(...args: unknown[]) {
      fixture.readReactions = args[6] as typeof fixture.readReactions
      fixture.readReply = args[3] as typeof fixture.readReply
    }
  }
}))
vi.mock("./host", () => ({
  LocalBotHost: class {
    stop = fixture.stop
    memoryChanged = fixture.memoryChanged
    hasActiveRuns = fixture.hasActiveRuns
    removeMessageReactionsForThreads = fixture.removeReactions
  }
}))
vi.mock("./runtime-adapter", () => ({ createLocalBotRunPort: vi.fn() }))
vi.mock("./memory", () => ({
  BotMemoryService: class {
    constructor(_root: string, onChanged: (botId: string) => void) {
      fixture.notifyMemory = onChanged
    }
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
  fixture.notifyMemory = undefined
  fixture.readReactions = undefined
  fixture.dataRoot = "/synthetic-test"
  fixture.openDatabase.mockReturnValue({ database: { close: fixture.databaseClose } })
  fixture.hasActiveRuns.mockReturnValue(true)
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
  it("resolves a private file-only reply from its own successful delivery receipt and sent bytes", async () => {
    const service = await import("./local-service")
    service.getLocalBotHost()
    fixture.getMessages.mockReturnValue([{
      id: "file-card", ordinal: 12, role: "assistant", content: "",
      tool_calls: [{ id: "delivery", name: "bot_deliver_files", args: {} }]
    }])
    const receipt = {
      id: "receipt", ordinal: 13, role: "tool", name: "bot_deliver_files", tool_call_id: "delivery",
      content: JSON.stringify({ kind: "bot-file-delivery", files: [
        { name: "report.json", size: 44, filePath: "/workspace/report.json", attachmentPath: "/workspace/.sent/v1.json" }
      ] })
    }
    fixture.getFollowingMessages.mockReturnValue([receipt])
    const reply = fixture.readReply!("owned-thread", "file-card") as { id: string; text: string; preview: string }
    expect(reply.id).toBe("file-card")
    expect(reply.text).toContain("report.json")
    expect(reply.text).toContain("/workspace/.sent/v1.json")
    expect(reply.preview).toBe("📎 report.json")
    expect(reply.text).not.toContain('"path":"/workspace/report.json"')
    for (const following of [
      [{ ...receipt, is_error: true }],
      [{ ...receipt, tool_call_id: "unrelated" }],
      [{ role: "user", content: "next turn" }, receipt],
      [{ role: "assistant", content: "next call" }, receipt]
    ]) {
      fixture.getFollowingMessages.mockReturnValue(following)
      expect((fixture.readReply!("owned-thread", "file-card") as { text: string }).text).toBe("")
    }
    await service.stopLocalBotHost()
  })
  it("uses the initialized host for committed reaction cleanup and fences cleanup during shutdown", async () => {
    const service = await import("./local-service")
    service.getLocalBotHost()
    service.removeLocalBotMessageReactionsForThreads(["deleted", "deleted"])
    expect(fixture.removeReactions).toHaveBeenCalledExactlyOnceWith(["deleted"])
    expect(fixture.openDatabase).toHaveBeenCalledTimes(1)
    await service.stopLocalBotHost()
    expect(() => service.removeLocalBotMessageReactionsForThreads(["late"])).toThrow("退出")
    expect(fixture.removeReactions).toHaveBeenCalledTimes(1)
  })

  it("removes only exact orphan thread reactions from dormant storage without starting or migrating Bots", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-reaction-cleanup-"))
    fixture.dataRoot = root
    const path = join(root, "bots", "control.sqlite")
    mkdirSync(join(root, "bots"))
    const db = new DatabaseSync(path)
    try {
      db.exec(
        "CREATE TABLE bot_message_reactions(scope_kind TEXT,scope_id TEXT,message_id TEXT,emoji TEXT); CREATE TABLE bot_meta(revision INTEGER); INSERT INTO bot_meta VALUES(7)"
      )
      const insert = db.prepare("INSERT INTO bot_message_reactions VALUES(?,?,?,?)")
      insert.run("thread", "deleted", "m", "😀")
      insert.run("thread", "kept", "m", "😀")
      insert.run("group", "deleted", "m", "😀")
      const service = await import("./local-service")
      service.removeLocalBotMessageReactionsForThreads(["deleted"])
      service.removeLocalBotMessageReactionsForThreads(["deleted"])
      expect(
        db
          .prepare("SELECT scope_kind,scope_id FROM bot_message_reactions ORDER BY scope_kind")
          .all()
      ).toEqual([
        { scope_kind: "group", scope_id: "deleted" },
        { scope_kind: "thread", scope_id: "kept" }
      ])
      expect(db.prepare("SELECT revision FROM bot_meta").get()?.revision).toBe(7)
      expect(fixture.openDatabase).not.toHaveBeenCalled()
      expect(fixture.readReactions).toBeUndefined() // no BotStore/host/runtime was constructed
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("does not create absent control storage or add a reaction schema to an older dormant database", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-reaction-cleanup-"))
    fixture.dataRoot = root
    const path = join(root, "bots", "control.sqlite")
    try {
      const service = await import("./local-service")
      service.removeLocalBotMessageReactionsForThreads(["deleted"])
      expect(existsSync(join(root, "bots"))).toBe(false)
      mkdirSync(join(root, "bots"))
      const db = new DatabaseSync(path)
      db.exec("CREATE TABLE original(value TEXT); INSERT INTO original VALUES('kept')")
      service.removeLocalBotMessageReactionsForThreads(["deleted"])
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: "original" }
      ])
      expect(db.prepare("SELECT value FROM original").get()?.value).toBe("kept")
      db.close()
      expect(fixture.openDatabase).not.toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails immediately when dormant control storage has a competing writer", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-reaction-cleanup-"))
    fixture.dataRoot = root
    mkdirSync(join(root, "bots"))
    const db = new DatabaseSync(join(root, "bots", "control.sqlite"))
    try {
      db.exec(
        "CREATE TABLE bot_message_reactions(scope_kind TEXT,scope_id TEXT,message_id TEXT,emoji TEXT); INSERT INTO bot_message_reactions VALUES('thread','deleted','m','😀'); BEGIN IMMEDIATE"
      )
      const service = await import("./local-service")
      const started = performance.now()
      expect(() => service.removeLocalBotMessageReactionsForThreads(["deleted"])).toThrow(
        /locked|busy/i
      )
      expect(performance.now() - started).toBeLessThan(1000)
      expect(db.prepare("SELECT COUNT(*) AS count FROM bot_message_reactions").get()?.count).toBe(1)
      expect(fixture.openDatabase).not.toHaveBeenCalled()
      expect(fixture.readReactions).toBeUndefined()
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves corrupt dormant storage untouched and does not invoke recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "bot-reaction-cleanup-"))
    fixture.dataRoot = root
    mkdirSync(join(root, "bots"))
    const path = join(root, "bots", "control.sqlite")
    const bytes = Buffer.from("not a sqlite database")
    writeFileSync(path, bytes)
    try {
      const service = await import("./local-service")
      expect(() => service.removeLocalBotMessageReactionsForThreads(["deleted"])).toThrow()
      expect(readFileSync(path)).toEqual(bytes)
      expect(fixture.openDatabase).not.toHaveBeenCalled()
      expect(fixture.readReactions).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it("reads reaction identities from the exact native thread, including file-only rows and without message bodies", async () => {
    const service = await import("./local-service")
    service.getLocalBotHost()
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "a", botHostId: "local" })
    })
    fixture.getMessages.mockReturnValue([
      { id: "file-only", role: "user", ordinal: 1, content: [] },
      { id: "reply", role: "assistant", ordinal: 2, content: "private body not returned" },
      { id: "tool", role: "tool", ordinal: 3, content: "hidden" },
      { id: "temporary", role: "assistant", content: "partial" }
    ])
    expect(fixture.readReactions!("a", "thread-a", ["file-only", "reply"])).toEqual([
      { id: "file-only", role: "user", ordinal: 1 },
      { id: "reply", role: "assistant", ordinal: 2 }
    ])
    expect(fixture.getMessages).toHaveBeenCalledWith("thread-a", ["file-only", "reply"])
    fixture.getMessages.mockClear()
    fixture.getThread.mockReturnValue({
      metadata: JSON.stringify({ botId: "other", botHostId: "local" })
    })
    expect(() => fixture.readReactions!("a", "thread-a", ["reply"])).toThrow("归属")
    expect(fixture.getMessages).not.toHaveBeenCalled()
    fixture.getThread.mockReturnValue({ metadata: "null" })
    expect(() => fixture.readReactions!("a", "thread-a", ["reply"])).toThrow("元数据")
    fixture.getThread.mockReturnValue(null)
    expect(fixture.readReactions!("a", "thread-a", ["reply"])).toEqual([])
    await service.stopLocalBotHost()
  }, 15_000)
  it("routes committed memory invalidation through the existing host and fences it on shutdown", async () => {
    const service = await import("./local-service")
    service.getLocalBotHost()
    fixture.notifyMemory!("bot-a")
    expect(fixture.memoryChanged.mock.calls).toEqual([["bot-a"]])
    const close = service.stopLocalBotHost()
    fixture.notifyMemory!("bot-a")
    await close
    expect(fixture.memoryChanged).toHaveBeenCalledTimes(1)
  })

  it("drains the host before closing resources, shares a single shutdown, and fences late IPC", async () => {
    let release!: () => void
    fixture.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const service = await import("./local-service")
    expect(service.hasActiveBotRuns()).toBe(false)
    service.getLocalBotHost()
    const first = service.stopLocalBotHost()
    expect(service.stopLocalBotHost()).toBe(first)
    expect(() => service.getLocalBotHost()).toThrow("退出")
    await Promise.resolve()
    expect(fixture.databaseClose).not.toHaveBeenCalled()
    expect(fixture.browserClose).not.toHaveBeenCalled()
    expect(service.hasActiveBotRuns()).toBe(true)
    release()
    await first
    expect(fixture.trace.slice(0, 2).sort()).toEqual(["browser", "summary"])
    expect(fixture.trace.slice(2)).toEqual(["memory", "database"])
    expect(fixture.stop).toHaveBeenCalledTimes(1)
    fixture.hasActiveRuns.mockImplementation(() => {
      throw new Error("Database is closed")
    })
    expect(service.hasActiveBotRuns()).toBe(false)
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
    fixture.hasActiveRuns.mockImplementation(() => {
      throw new Error("Database is closed")
    })
    expect(service.hasActiveBotRuns()).toBe(false)
  })
})
